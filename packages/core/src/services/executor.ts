import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, gte, inArray, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  buildAccountKey,
  ReviewContractSchema,
  TaskResultContractSchema,
  type AgentProfileDTO,
  type ApproveMergeInput,
  type ExecutionStateDTO,
  type GuardStateDTO,
  type GuardTaskEntryDTO,
  type IntegrationRunDTO,
  type PlanDTO,
  type ProviderId,
  type ProviderRuntimeStateDTO,
  type PushPrInput,
  type PushPrResultDTO,
  type RejectTaskInput,
  type ReviewContract,
  type RunKind,
  type RunStatus,
  type SessionSummaryDTO,
  type StartExecutionInput,
  type TaskDiffDTO,
  type TaskDispatchPreviewDTO,
  type TaskDTO,
  type TaskResultContract,
  type TaskReviewDTO,
  type TaskRunDTO,
  type UiLanguage,
} from '@dalang/shared';
import { createTurnLogger } from '../adapters/logger.js';
import type { ProviderRegistry } from '../adapters/registry.js';
import type { TurnTokenUsage } from '../adapters/types.js';
import { getDbDataDir, type DalangDb } from '../db/client.js';
import {
  agentProfiles,
  integrationRuns,
  plans,
  projects,
  providerEvents,
  reviews,
  runs,
  sessions,
  tasks,
} from '../db/schema.js';
import {
  getProjectLogsDir,
  getSessionLogsDir,
  getSessionTaskArtifactDir,
  getTaskArtifactDir,
  getTaskWorktreeDir,
  getWorktreesRoot,
} from '../paths.js';
import {
  ensureProjectDir,
  readArtifactFile,
  removeArtifactFile,
  writeArtifactFile,
} from '../safe-fs.js';
import { formatZodError } from './contract.js';
import type { DalangEventBus } from './events.js';
import {
  branchExists,
  createGitCheckpoint,
  createGitHubPullRequest,
  createHiddenCheckpointRef,
  createTaskWorktree,
  deleteTaskBranch,
  detectDefaultGitRemote,
  ensureMainBaseline,
  getChangedFilesBetween,
  getHeadCommit,
  getRepoState,
  getTaskDiff,
  isAncestorCommit,
  mergeTaskBranchToMain,
  pushRefToRemote,
  removeTaskWorktree,
  rollbackGitToCheckpoint,
} from './git.js';
import type { LeadService } from './lead.js';
import { estimateApiEquivalentCostUsd, mergeTokenUsage, usageDbFields } from './pricing.js';
import { ProfileService } from './profiles.js';
import { detectIntegrationCommand } from './project.js';
import {
  buildFixPrompt,
  buildReviewPrompt,
  readArtifactWithGitFallback,
  tailOutput,
  validateReviewTurnOutput,
} from './review.js';
import {
  computeTaskWaves,
  globsOverlap,
  ProviderLimiter,
  type SlotLease,
} from './scheduler.js';

export interface ExecutionServiceOptions {
  worktreesRoot?: string;
  quotaCooldownMs?: number;
  getLanguage?: () => UiLanguage;
}

interface ActiveTaskExecution {
  projectId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  controller: AbortController;
  promise: Promise<RunStatus>;
}

interface ProjectQueueExecution {
  projectId: string;
  sessionId: string;
  cancelled: boolean;
  controller: AbortController;
  inFlightTaskIds: Set<string>;
  wake: () => void;
  promise: Promise<void>;
}

interface ProviderUsability {
  usable: boolean;
  kind: 'ok' | 'blocked' | 'quota' | 'cooldown';
  reason: string | null;
}

const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_RE = /rate[_ ]?limit|usage limit|hit your limit|quota exceeded|too many requests|\b429\b/i;
const LOGIN_EXPIRED_RE = /not logged in|unauthorized|authentication required|please log in|token expired/i;

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  let regexStr = '^';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 2;
        } else {
          regexStr += '.*';
          i += 1;
        }
      } else {
        regexStr += '[^/]*';
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else {
      regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export function findScopeViolations(changedFiles: string[], filesAllowed: string[]): string[] {
  if (filesAllowed.length === 0) return [];
  const matchers = filesAllowed.map(globToRegex);
  const warnings: string[] = [];

  for (const rawFile of changedFiles) {
    const file = rawFile.replace(/^\.\//, '');
    if (file === '.dalang' || file.startsWith('.dalang/')) continue;
    const allowed = matchers.some((re) => re.test(file));
    if (!allowed) {
      warnings.push(`Modified outside files_allowed: ${file}`);
    }
  }
  return warnings;
}

export function classifyProviderFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  errMsg?: string,
): { eventType: 'rate_limit' | 'login_expired' | 'timeout' | 'error'; reason: string } {
  const combined = `${errMsg ?? ''}\n${stderr}\n${stdout}`;
  if (RATE_LIMIT_RE.test(combined)) {
    return {
      eventType: 'rate_limit',
      reason: 'Provider rate limit or quota reached',
    };
  }
  if (LOGIN_EXPIRED_RE.test(combined)) {
    return {
      eventType: 'login_expired',
      reason: 'Provider CLI login session expired or unauthenticated',
    };
  }
  if (/timed out/i.test(combined)) {
    return {
      eventType: 'timeout',
      reason: errMsg || 'CLI execution timed out',
    };
  }
  return {
    eventType: 'error',
    reason: errMsg || `CLI exited with code ${exitCode ?? 'unknown'}`,
  };
}

/**
 * Coder turns must write source files and `result.json`, so `read-only` is upgraded there;
 * review turns preserve the profile's `permissionMode` directly.
 */
function writePermission(profile: AgentProfileDTO): 'workspace-write' | 'accept-edits' {
  return profile.permissionMode === 'read-only' ? 'workspace-write' : profile.permissionMode;
}

/** "codex · gpt-5" for a fallback run: the role stays the same, so the CLI and model are what differ. */
function routeLabel(p: { provider: string; model: string }): string {
  return p.model ? `${p.provider} · ${p.model}` : p.provider;
}

export class ExecutionService {
  private readonly profiles: ProfileService;
  private readonly worktreesRoot: string;
  private readonly quotaCooldownMs: number;
  private readonly getLanguage: () => UiLanguage;
  private readonly limiter = new ProviderLimiter();
  private readonly activeTasks = new Map<string, ActiveTaskExecution>();
  private readonly projectQueues = new Map<string, ProjectQueueExecution>();
  private readonly projectGitLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DalangDb,
    private readonly registry: ProviderRegistry,
    private readonly leadService: LeadService,
    private readonly events?: DalangEventBus,
    options: ExecutionServiceOptions = {},
  ) {
    this.profiles = new ProfileService(db);
    this.worktreesRoot = options.worktreesRoot ?? getWorktreesRoot(getDbDataDir(db));
    this.quotaCooldownMs = options.quotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS;
    this.getLanguage = options.getLanguage ?? (() => 'en');
    this.reconcileInterruptedRuns();
  }

  /**
   * Reconcile any runs/tasks left in `running` or `reviewing` state from an unexpected exit/restart.
   */
  private reconcileInterruptedRuns(): void {
    const staleRuns = this.db.select().from(runs).where(eq(runs.status, 'running')).all();
    const now = new Date().toISOString();
    if (staleRuns.length > 0) {
      this.db
        .update(runs)
        .set({
          status: 'stopped',
          finishedAt: now,
          failureReason: 'Interrupted by server restart',
        })
        .where(eq(runs.status, 'running'))
        .run();
    }
    this.db
      .update(tasks)
      .set({ status: 'stopped', updatedAt: now })
      .where(inArray(tasks.status, ['running', 'reviewing']))
      .run();

    const allSessions = this.db.select({ id: sessions.id }).from(sessions).all();
    for (const s of allSessions) {
      this.leadService.reconcileSessionWorkState(s.id, false);
    }
  }

  private async withProjectGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectGitLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => current, () => current);
    this.projectGitLocks.set(projectId, chained);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.projectGitLocks.get(projectId) === chained) {
        this.projectGitLocks.delete(projectId);
      }
    }
  }

  private appendDalangLog(logFileAbs: string, line: string): void {
    const logger = createTurnLogger(logFileAbs);
    try {
      logger.write(line);
    } finally {
      logger.close();
    }
  }

  private getProjectRow(projectId: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return row;
  }

  private recordProviderEvent(
    provider: ProviderId,
    type: 'rate_limit' | 'login_expired' | 'timeout' | 'error' | 'quota_fallback',
    detail: string,
    configDir?: string | null,
  ): void {
    const accountKey = buildAccountKey(provider, configDir);
    this.db
      .insert(providerEvents)
      .values({
        id: crypto.randomUUID(),
        provider,
        accountKey,
        type,
        detail: detail.slice(0, 300),
        createdAt: new Date().toISOString(),
      })
      .run();
    this.events?.emitEvent({ type: 'provider.updated', provider });
  }

  private getProviderCooldownInfo(
    provider: ProviderId,
    configDir?: string | null,
  ): {
    inCooldown: boolean;
    reason: string | null;
    until: string | null;
  } {
    const targetAccountKey = buildAccountKey(provider, configDir);
    const clearedAt = this.registry.getRateLimitClearedAt(provider, configDir);
    const recentEvents = this.db
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.provider, provider))
      .orderBy(desc(providerEvents.createdAt))
      .all();

    const now = Date.now();
    const cutoff = Math.max(now - this.quotaCooldownMs, clearedAt);

    for (const ev of recentEvents) {
      const evAccount = ev.accountKey ?? ev.provider;
      if (evAccount !== targetAccountKey) continue;
      const evTime = new Date(ev.createdAt).getTime();
      if (Number.isNaN(evTime) || evTime <= cutoff) break;
      if (ev.type === 'rate_limit') {
        return {
          inCooldown: true,
          reason: ev.detail || 'Recent rate limit reached',
          until: new Date(evTime + this.quotaCooldownMs).toISOString(),
        };
      }
      if (ev.type === 'login_expired') {
        return {
          inCooldown: true,
          reason: ev.detail || 'CLI login session expired',
          until: new Date(evTime + this.quotaCooldownMs).toISOString(),
        };
      }
    }

    return { inCooldown: false, reason: null, until: null };
  }

  private evaluateProviderUsability(
    provider: ProviderId,
    model: string | null,
    sandboxReady: boolean,
    configDir?: string | null,
  ): ProviderUsability {
    const blocked = this.registry.providerBlockedReason(provider, sandboxReady);
    if (blocked) {
      return { usable: false, kind: 'blocked', reason: blocked };
    }

    const cachedUsage = this.registry.getCachedUsage(provider, configDir);
    const exhaustedReason = this.registry.isUsageExhausted(
      cachedUsage?.usage,
      model,
      cachedUsage ? Date.now() - cachedUsage.checkedAt : 0,
    );
    if (exhaustedReason) {
      return { usable: false, kind: 'quota', reason: exhaustedReason };
    }

    const cooldown = this.getProviderCooldownInfo(provider, configDir);
    if (cooldown.inCooldown) {
      return { usable: false, kind: 'cooldown', reason: cooldown.reason };
    }

    return { usable: true, kind: 'ok', reason: null };
  }

  getProviderRuntimeStates(): ProviderRuntimeStateDTO[] {
    const allProfiles = this.profiles.listProfiles();
    const providersList: ProviderId[] = ['claude-code', 'codex', 'antigravity'];
    const accounts: Array<{ provider: ProviderId; configDir: string | null; accountKey: string }> =
      providersList.map((provider) => ({ provider, configDir: null, accountKey: provider }));

    // Accounts come from profiles and from fallback targets (a second account is often only a fallback).
    const named: Array<{ provider: ProviderId; configDir: string | null }> = [
      ...allProfiles,
      ...allProfiles.flatMap((p) => (p.fallback ? [p.fallback] : [])),
      ...this.profiles.listRoutingRules().flatMap((r) => (r.fallback ? [r.fallback] : [])),
    ];
    for (const entry of named) {
      const dir = entry.configDir?.trim() || null;
      if (!dir) continue;
      const key = buildAccountKey(entry.provider, dir);
      if (!accounts.some((a) => a.accountKey === key)) {
        accounts.push({ provider: entry.provider, configDir: dir, accountKey: key });
      }
    }

    return accounts.map(({ provider, configDir, accountKey }) => {
      const matching = allProfiles.filter(
        (p) => p.provider === provider && buildAccountKey(p.provider, p.configDir) === accountKey,
      );
      const maxParallel = matching.reduce((max, p) => Math.max(max, p.maxParallel), 1);
      const cooldown = this.getProviderCooldownInfo(provider, configDir);
      const cachedUsage = this.registry.getCachedUsage(provider, configDir);
      const quotaReason = this.registry.isUsageExhausted(
        cachedUsage?.usage,
        null,
        cachedUsage ? Date.now() - cachedUsage.checkedAt : 0,
      );
      return {
        provider,
        accountKey,
        configDir,
        activeCount: this.limiter.getActiveCount(accountKey),
        maxParallel,
        inCooldown: cooldown.inCooldown,
        cooldownReason: cooldown.reason,
        cooldownUntil: cooldown.until,
        quotaExhausted: Boolean(quotaReason),
        quotaReason,
      };
    });
  }

  private getActiveTasksForProject(projectId: string): ActiveTaskExecution[] {
    return [...this.activeTasks.values()].filter((t) => t.projectId === projectId);
  }

  private hasActiveTasksForProject(projectId: string): boolean {
    return [...this.activeTasks.values()].some((t) => t.projectId === projectId);
  }

  assignTaskProfile(
    projectId: string,
    taskId: string,
    profileOverride: string | null,
    explicitSessionId?: string,
  ): TaskDTO {
    const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('No plan exists for this project.');
    const target = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!target) throw new Error(`Task not found: ${taskId}`);
    if (target.status === 'running' || target.status === 'reviewing' || this.activeTasks.has(target.id)) {
      throw new Error(`Cannot reassign ${target.externalId} while it is ${target.status}.`);
    }

    if (profileOverride !== null) {
      const allProfiles = this.profiles.listProfiles();
      const matched = allProfiles.find(
        (p) => p.id === profileOverride || p.name === profileOverride,
      );
      if (!matched) {
        throw new Error(`Unknown agent profile: ${profileOverride}`);
      }
      profileOverride = matched.id;
    }

    this.db
      .update(tasks)
      .set({ profileOverride, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, target.id))
      .run();

    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });
    return this.leadService.getPlan(projectId, sid)!.tasks.find((t) => t.id === target.id)!;
  }

  private getTaskIdsForSession(sessionId: string): string[] {
    const sessionPlans = this.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .all();
    if (sessionPlans.length === 0) return [];
    return this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.planId, sessionPlans.map((p) => p.id)))
      .all()
      .map((t) => t.id);
  }

  async getExecutionState(
    projectId: string,
    explicitSessionId?: string,
  ): Promise<ExecutionStateDTO> {
    const project = this.getProjectRow(projectId);
    const sessionId = this.leadService.resolveSessionIdForRead(projectId, explicitSessionId);
    const plan = sessionId ? this.leadService.getPlan(projectId, sessionId) : null;
    const sandboxEngine = await this.registry.getSandboxEngine();
    const sandboxReady = sandboxEngine !== 'none';

    const dispatchPreviews = plan ? this.buildDispatchPreviews(plan, sandboxReady) : [];
    const sessionTaskIds = sessionId ? this.getTaskIdsForSession(sessionId) : [];
    // Snapshot active tasks/queue and run rows synchronously before any await so a phase
    // transition (e.g. coder -> review) cannot mutate execHandle.runId after runRows was read.
    const activeTaskList = this.getActiveTasksForProject(projectId).filter(
      (a) => !sessionId || a.sessionId === sessionId,
    );
    const activeRunIds = new Set(activeTaskList.map((a) => a.runId).filter(Boolean));
    const queue = this.projectQueues.get(projectId);
    const queueRunning = Boolean(
      queue && !queue.cancelled && (!sessionId || queue.sessionId === sessionId),
    );
    const runRows =
      sessionTaskIds.length === 0
        ? []
        : this.db
            .select()
            .from(runs)
            .where(and(eq(runs.projectId, projectId), inArray(runs.taskId, sessionTaskIds)))
            .orderBy(desc(runs.startedAt), desc(runs.attempt))
            .all();

    const taskById = new Map((plan?.tasks ?? []).map((t) => [t.id, t]));
    const profileById = new Map(this.profiles.listProfiles().map((p) => [p.id, p]));

    const runDtos = await Promise.all(
      runRows.map((row) =>
        this.toRunDTO(project.path, row, taskById.get(row.taskId), profileById.get(row.profileId)),
      ),
    );

    const activeRuns = runDtos.filter((r) => activeRunIds.has(r.id) || r.status === 'running');

    return {
      projectId,
      sessionId,
      planStatus: plan ? plan.status : 'none',
      activeRun: activeRuns[0] ?? null,
      activeRuns,
      queueRunning,
      sandboxReady,
      sandboxEngine,
      platform: process.platform,
      providerStates: this.getProviderRuntimeStates(),
      dispatchPreviews,
      runs: runDtos,
    };
  }

  private routeTask(
    task: Pick<TaskDTO, 'role' | 'complexity' | 'profileOverride'>,
    sandboxReady: boolean,
  ): ReturnType<ProfileService['resolveProfileForTask']> & {
    note: string | null;
    quotaReroutedReason: string | null;
    proactiveFallback: boolean;
    skippedPrimaryProvider: ProviderId | null;
    skippedPrimaryConfigDir: string | null;
    blocked: string | null;
  } {
    const routing = this.profiles.resolveProfileForTask({
      role: task.role,
      complexity: task.complexity,
      profileOverride: task.profileOverride,
    });
    const primaryStatus = this.evaluateProviderUsability(
      routing.primary.provider,
      routing.primary.model || null,
      sandboxReady,
      routing.primary.configDir,
    );
    if (primaryStatus.usable) {
      return {
        ...routing,
        note: null,
        quotaReroutedReason: null,
        proactiveFallback: false,
        skippedPrimaryProvider: null,
        skippedPrimaryConfigDir: null,
        blocked: null,
      };
    }

    const backup = routing.fallback;
    if (backup) {
      const backupStatus = this.evaluateProviderUsability(
        backup.provider,
        backup.model || null,
        sandboxReady,
        backup.configDir,
      );
      if (backupStatus.usable) {
        if (primaryStatus.kind === 'blocked') {
          return {
            ...routing,
            primary: backup,
            fallback: null,
            note: `${routing.primary.name} routes to Antigravity, which is off. Running on ${routeLabel(backup)} instead. Enable keyring access in the Antigravity profile editor to use it.`,
            quotaReroutedReason: null,
            proactiveFallback: false,
            skippedPrimaryProvider: null,
            skippedPrimaryConfigDir: null,
            blocked: null,
          };
        }
        const reasonText = `${routing.primary.name} (${routing.primary.provider}) skipped (${primaryStatus.reason}); proactively routed to the fallback ${routeLabel(backup)}.`;
        return {
          ...routing,
          primary: backup,
          fallback: null,
          note: reasonText,
          quotaReroutedReason: reasonText,
          proactiveFallback: true,
          skippedPrimaryProvider: routing.primary.provider,
          skippedPrimaryConfigDir: routing.primary.configDir ?? null,
          blocked: null,
        };
      }
    }

    return {
      ...routing,
      note: null,
      quotaReroutedReason: null,
      proactiveFallback: false,
      skippedPrimaryProvider: null,
      skippedPrimaryConfigDir: null,
      blocked: primaryStatus.reason,
    };
  }

  private findOverlappingActiveTask(plan: PlanDTO, target: TaskDTO): TaskDTO | null {
    return (
      plan.tasks.find(
        (other) =>
          other.id !== target.id &&
          (this.activeTasks.has(other.id) ||
            other.status === 'running' ||
            other.status === 'reviewing' ||
            other.status === 'awaiting_merge' ||
            other.status === 'review_failed') &&
          globsOverlap(target.filesAllowed, other.filesAllowed),
      ) ?? null
    );
  }

  private buildDispatchPreviews(plan: PlanDTO, sandboxReady: boolean): TaskDispatchPreviewDTO[] {
    const statusByExternal = new Map(plan.tasks.map((t) => [t.externalId, t.status]));
    const waves = computeTaskWaves(plan.tasks);

    return plan.tasks.map((task) => {
      const pendingDeps = task.dependsOn.filter((dep) => statusByExternal.get(dep) !== 'done');
      const dependenciesSatisfied = pendingDeps.length === 0;
      const routing = this.routeTask(task, sandboxReady);
      const wave = waves.get(task.externalId) ?? 0;

      const overlappingTasks = plan.tasks
        .filter(
          (other) =>
            other.id !== task.id &&
            other.status !== 'done' &&
            globsOverlap(task.filesAllowed, other.filesAllowed),
        )
        .map((other) => other.externalId);

      const activeOverlap = this.findOverlappingActiveTask(plan, task);
      const blockedByOverlapWith =
        task.status === 'approved' && activeOverlap ? activeOverlap.externalId : null;

      let blockedReason: string | null = null;
      if (plan.status !== 'approved') {
        blockedReason = 'Plan is not approved yet';
      } else if (task.status === 'done') {
        blockedReason = null;
      } else if (task.status === 'awaiting_merge') {
        blockedReason = 'Passed review; awaiting merge approval in Guard';
      } else if (task.status === 'review_failed') {
        blockedReason = 'Review failed after max rounds; inspect in Guard or Retry';
      } else if (task.status === 'running') {
        blockedReason = 'Currently running';
      } else if (task.status === 'reviewing') {
        blockedReason = 'Currently in review';
      } else if (task.status === 'failed' || task.status === 'stopped') {
        blockedReason = `Task is ${task.status}; use Retry or Resume`;
      } else if (!dependenciesSatisfied) {
        blockedReason = `Waiting on ${pendingDeps.join(', ')}`;
      } else if (blockedByOverlapWith && activeOverlap) {
        blockedReason = `Waiting: files overlap with ${blockedByOverlapWith} (${activeOverlap.status})`;
      }

      const eligible =
        plan.status === 'approved' &&
        task.status === 'approved' &&
        dependenciesSatisfied &&
        !blockedByOverlapWith &&
        routing.blocked === null;
      if (!eligible && blockedReason === null && routing.blocked && task.status !== 'done') {
        blockedReason = routing.blocked;
      }

      return {
        taskId: task.id,
        externalId: task.externalId,
        title: task.title,
        milestone: task.milestone,
        role: task.role,
        complexity: task.complexity,
        status: task.status,
        dependsOn: task.dependsOn,
        wave,
        overlappingTasks,
        blockedByOverlapWith,
        dependenciesSatisfied,
        eligible,
        blockedReason,
        resolvedProfileId: routing.primary.id,
        resolvedProfileName: routing.primary.name,
        resolvedProvider: routing.primary.provider,
        resolvedModel: routing.primary.model,
        fallback: routing.fallback
          ? {
              provider: routing.fallback.provider,
              model: routing.fallback.model,
              effort: routing.fallback.effort,
              configDir: routing.fallback.configDir,
            }
          : null,
        selectionSource: routing.source,
        selectionNote: routing.note,
        quotaReroutedReason: routing.quotaReroutedReason,
      };
    });
  }

  startExecution(
    projectId: string,
    input: Partial<StartExecutionInput> = {},
  ): Promise<{ started: boolean; run: TaskRunDTO | null; runs?: TaskRunDTO[]; queueMode: boolean }> {
    this.getProjectRow(projectId);

    const sessionId = input.taskId
      ? this.leadService.resolveSessionIdForTask(projectId, input.taskId, input.sessionId)
      : this.leadService.resolveSessionIdForRead(projectId, input.sessionId);

    if (sessionId) {
      try {
        this.leadService.assertCanStartWorkInSession(projectId, sessionId);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    if (input.taskId) {
      const plan = sessionId ? this.leadService.getPlan(projectId, sessionId) : null;
      const target = plan?.tasks.find((t) => t.id === input.taskId || t.externalId === input.taskId);
      if (target && this.activeTasks.has(target.id)) {
        return Promise.reject(new Error(`Task ${target.externalId} is already running.`));
      }

      // Reserve the task slot synchronously before the first await.
      const reservationKey = target?.id ?? `${projectId}:${input.taskId}`;
      const reservation: ActiveTaskExecution = {
        projectId,
        sessionId: sessionId ?? '',
        taskId: reservationKey,
        runId: '',
        controller: new AbortController(),
        promise: Promise.resolve('stopped'),
      };
      this.activeTasks.set(reservationKey, reservation);

      return this.startSingleTaskReserved(
        projectId,
        sessionId,
        input,
        reservationKey,
        reservation,
      ).catch((err) => {
        if (this.activeTasks.get(reservationKey) === reservation) {
          this.activeTasks.delete(reservationKey);
        }
        if (sessionId) {
          this.leadService.reconcileSessionWorkState(sessionId, false);
        }
        throw err;
      });
    }

    if (this.projectQueues.has(projectId)) {
      return Promise.reject(new Error('An execution run is already in progress for this project.'));
    }

    let wakeFn = () => {};
    const queueHandle: ProjectQueueExecution = {
      projectId,
      sessionId: sessionId ?? '',
      cancelled: false,
      controller: new AbortController(),
      inFlightTaskIds: new Set(),
      wake: () => wakeFn(),
      promise: Promise.resolve(),
    };
    this.projectQueues.set(projectId, queueHandle);

    return this.startQueueReserved(projectId, sessionId, input, queueHandle, (fn) => {
      wakeFn = fn;
    }).catch((err) => {
      if (this.projectQueues.get(projectId) === queueHandle) {
        this.projectQueues.delete(projectId);
      }
      if (sessionId) {
        this.leadService.reconcileSessionWorkState(sessionId, false);
      }
      throw err;
    });
  }

  private async startSingleTaskReserved(
    projectId: string,
    explicitSessionId: string | null,
    input: Partial<StartExecutionInput>,
    reservationKey: string,
    reservation: ActiveTaskExecution,
  ): Promise<{ started: boolean; run: TaskRunDTO | null; runs?: TaskRunDTO[]; queueMode: boolean }> {
    const allowUnconfined = Boolean(input.allowUnconfined);
    const resumeSession = Boolean(input.resumeSession);
    const sandboxReady = await this.registry.isSandboxReady();
    if (!sandboxReady && !allowUnconfined) {
      throw new Error(
        `Bubblewrap sandbox is unavailable on ${process.platform}. Confirm unconfined execution to run tasks without sandbox confinement.`,
      );
    }

    const sessionId =
      explicitSessionId ??
      this.leadService.resolveSessionIdForTask(projectId, input.taskId ?? '', input.sessionId);
    const plan = sessionId ? this.leadService.getPlan(projectId, sessionId) : null;
    if (!plan || !sessionId) {
      throw new Error('No plan exists yet. Generate and approve a plan in List first.');
    }
    if (plan.status !== 'approved') {
      throw new Error('Plan must be approved in List before execution can start.');
    }
    this.leadService.markSessionWorking(projectId, sessionId);
    reservation.sessionId = sessionId;

    const target = plan.tasks.find((t) => t.id === input.taskId || t.externalId === input.taskId);
    if (!target) throw new Error(`Task not found: ${input.taskId}`);
    if (target.status === 'running' || target.status === 'reviewing') {
      throw new Error(`Task ${target.externalId} is currently ${target.status}.`);
    }

    if (reservationKey !== target.id) {
      if (this.activeTasks.has(target.id)) {
        throw new Error(`Task ${target.externalId} is already running.`);
      }
      this.activeTasks.delete(reservationKey);
      reservation.taskId = target.id;
      this.activeTasks.set(target.id, reservation);
    }

    const statusByExt = new Map(plan.tasks.map((t) => [t.externalId, t.status]));
    const unmet = target.dependsOn.filter((d) => statusByExt.get(d) !== 'done');
    if (unmet.length > 0) {
      throw new Error(
        `Cannot run ${target.externalId}: waiting for dependencies ${unmet.join(', ')} to finish and merge.`,
      );
    }

    const overlap = this.findOverlappingActiveTask(plan, target);
    if (overlap) {
      throw new Error(
        `Cannot run ${target.externalId}: files_allowed overlaps with ${overlap.externalId} (${overlap.status}). Wait for it to merge or finish.`,
      );
    }

    let resumeSessionId: string | null = null;
    if (resumeSession) {
      const routing = this.routeTask(target, sandboxReady);
      const prevRuns = this.db
        .select()
        .from(runs)
        .where(and(eq(runs.taskId, target.id), ne(runs.kind, 'review')))
        .orderBy(desc(runs.startedAt), desc(runs.attempt))
        .all();
      const sameProviderRun = prevRuns.find(
        (r) => Boolean(r.cliSessionId) && r.provider === routing.primary.provider,
      );
      if (!sameProviderRun) {
        const otherSession = prevRuns.find((r) => Boolean(r.cliSessionId));
        if (otherSession) {
          throw new Error(
            `Previous session on ${target.externalId} belongs to ${otherSession.provider}, but current profile uses ${routing.primary.provider}. Use Retry or switch profile back to ${otherSession.provider}.`,
          );
        }
        throw new Error(`No previous CLI session ID found to resume ${target.externalId}.`);
      }
      resumeSessionId = sameProviderRun.cliSessionId!;
    }

    const launched = await this.launchTaskExecution(projectId, sessionId, target, reservation, {
      resumeSessionId,
      preAcquiredLease: null,
    });
    return { started: true, run: launched.initialRun, runs: [launched.initialRun], queueMode: false };
  }

  private async startQueueReserved(
    projectId: string,
    explicitSessionId: string | null,
    input: Partial<StartExecutionInput>,
    queueHandle: ProjectQueueExecution,
    bindWake: (fn: () => void) => void,
  ): Promise<{ started: boolean; run: TaskRunDTO | null; runs?: TaskRunDTO[]; queueMode: boolean }> {
    const allowUnconfined = Boolean(input.allowUnconfined);
    const sandboxReady = await this.registry.isSandboxReady();
    if (!sandboxReady && !allowUnconfined) {
      throw new Error(
        `Bubblewrap sandbox is unavailable on ${process.platform}. Confirm unconfined execution to run tasks without sandbox confinement.`,
      );
    }

    const sessionId =
      explicitSessionId ?? this.leadService.resolveSessionIdForRead(projectId, input.sessionId);
    const plan = sessionId ? this.leadService.getPlan(projectId, sessionId) : null;
    if (!plan || !sessionId) {
      throw new Error('No plan exists yet. Generate and approve a plan in List first.');
    }
    if (plan.status !== 'approved') {
      throw new Error('Plan must be approved in List before execution can start.');
    }

    const previews = this.buildDispatchPreviews(plan, sandboxReady);
    const eligiblePreviews = previews.filter((p) => p.eligible && !this.activeTasks.has(p.taskId));
    if (eligiblePreviews.length === 0) {
      const allDone = plan.tasks.every((t) => t.status === 'done');
      if (allDone) {
        throw new Error('All tasks in this plan are already done.');
      }
      const awaitingMergeCount = plan.tasks.filter(
        (t) => t.status === 'awaiting_merge' || t.status === 'review_failed',
      ).length;
      if (awaitingMergeCount > 0) {
        throw new Error(
          `${awaitingMergeCount} task(s) are waiting in Guard for merge approval before dependent tasks can start.`,
        );
      }
      throw new Error(
        'No eligible approved tasks to dispatch. Check blocked dependencies or retry failed/stopped tasks.',
      );
    }

    this.leadService.markSessionWorking(projectId, sessionId);
    queueHandle.sessionId = sessionId;

    // Synchronously dispatch the initial parallel batch of non-overlapping tasks up to provider limits.
    const initialRuns: TaskRunDTO[] = [];
    const startedNow: TaskDTO[] = [];
    const launchBatchTasks = async (): Promise<{
      launched: TaskRunDTO[];
      waitingForSlot: boolean;
      firstError: Error | null;
    }> => {
      const latestPlan = this.leadService.getPlan(projectId, sessionId);
      if (!latestPlan || queueHandle.cancelled) {
        return { launched: [], waitingForSlot: false, firstError: null };
      }
      const sandboxNow = await this.registry.isSandboxReady();
      const latestPreviews = this.buildDispatchPreviews(latestPlan, sandboxNow);
      const taskById = new Map(latestPlan.tasks.map((t) => [t.id, t]));

      const candidates = latestPreviews
        .filter((p) => p.eligible && !this.activeTasks.has(p.taskId))
        .sort((a, b) => {
          const ta = taskById.get(a.taskId)!;
          const tb = taskById.get(b.taskId)!;
          return ta.position - tb.position;
        });

      const batchPicked: Array<{ task: TaskDTO; lease: SlotLease; taskHandle: ActiveTaskExecution }> = [];
      let waitingForSlot = false;

      for (const cand of candidates) {
        const task = taskById.get(cand.taskId);
        if (!task) continue;
        // Guard against starting two tasks from the same batch whose files overlap.
        if (batchPicked.some((p) => globsOverlap(p.task.filesAllowed, task.filesAllowed))) {
          continue;
        }
        const routing = this.routeTask(task, sandboxNow);
        if (routing.blocked) continue;

        const leaseKey = buildAccountKey(routing.primary.provider, routing.primary.configDir);
        const lease = this.limiter.tryAcquire(leaseKey, routing.primary.maxParallel);
        if (!lease) {
          waitingForSlot = true;
          continue;
        }

        const taskHandle: ActiveTaskExecution = {
          projectId,
          sessionId,
          taskId: task.id,
          runId: '',
          controller: new AbortController(),
          promise: Promise.resolve('stopped'),
        };
        this.activeTasks.set(task.id, taskHandle);
        queueHandle.inFlightTaskIds.add(task.id);
        batchPicked.push({ task, lease, taskHandle });
      }

      const batchRuns: TaskRunDTO[] = [];
      let firstError: Error | null = null;
      await Promise.all(
        batchPicked.map(async ({ task, lease, taskHandle }) => {
          try {
            const launched = await this.launchTaskExecution(projectId, sessionId, task, taskHandle, {
              resumeSessionId: null,
              preAcquiredLease: lease,
            });
            startedNow.push(task);
            batchRuns.push(launched.initialRun);
            launched.completionPromise.finally(() => {
              queueHandle.inFlightTaskIds.delete(task.id);
              queueHandle.wake();
            });
          } catch (err) {
            lease.release();
            queueHandle.inFlightTaskIds.delete(task.id);
            if (this.activeTasks.get(task.id) === taskHandle) {
              this.activeTasks.delete(task.id);
            }
            const errObj = err instanceof Error ? err : new Error(String(err));
            if (!firstError) firstError = errObj;
            this.events?.emitEvent({
              type: 'run.finished',
              projectId,
              sessionId,
              taskId: task.id,
              runId: taskHandle.runId,
              status: 'failed',
              error: errObj.message,
            });
            queueHandle.wake();
          }
        }),
      );

      return { launched: batchRuns, waitingForSlot, firstError };
    };

    let currentWakeResolver: (() => void) | null = null;
    bindWake(() => {
      if (currentWakeResolver) {
        const res = currentWakeResolver;
        currentWakeResolver = null;
        res();
      }
    });

    const unsubRelease = this.limiter.onRelease(() => {
      queueHandle.wake();
    });

    let firstBatch: Awaited<ReturnType<typeof launchBatchTasks>>;
    try {
      firstBatch = await launchBatchTasks();
      if (
        firstBatch.launched.length === 0 &&
        queueHandle.inFlightTaskIds.size === 0 &&
        firstBatch.firstError
      ) {
        throw firstBatch.firstError;
      }
    } catch (err) {
      unsubRelease();
      throw err;
    }
    initialRuns.push(...firstBatch.launched);

    queueHandle.promise = (async () => {
      try {
        let waitingForSlot = firstBatch.waitingForSlot;
        while (!queueHandle.cancelled) {
          if (queueHandle.inFlightTaskIds.size === 0 && !waitingForSlot) {
            break;
          }

          await new Promise<void>((resolve) => {
            currentWakeResolver = resolve;
            if (queueHandle.cancelled) {
              currentWakeResolver = null;
              resolve();
            }
          });
          if (queueHandle.cancelled) break;

          const nextBatch = await launchBatchTasks();
          waitingForSlot = nextBatch.waitingForSlot;
          if (queueHandle.inFlightTaskIds.size === 0 && !waitingForSlot) {
            break;
          }
        }
      } finally {
        unsubRelease();
        if (this.projectQueues.get(projectId) === queueHandle) {
          this.projectQueues.delete(projectId);
        }
        const stillActive = [...this.activeTasks.values()].some((a) => a.sessionId === sessionId);
        this.leadService.reconcileSessionWorkState(sessionId, stillActive);
      }
    })();

    return {
      started: true,
      run: initialRuns[0] ?? null,
      runs: initialRuns,
      queueMode: true,
    };
  }

  async waitForProjectExecution(projectId: string): Promise<void> {
    while (true) {
      const queue = this.projectQueues.get(projectId);
      const tasksNow = this.getActiveTasksForProject(projectId);
      if (!queue && tasksNow.length === 0) break;
      await Promise.all([
        queue?.promise.catch(() => undefined),
        ...tasksNow.map((t) => t.promise.catch(() => undefined)),
      ]);
    }
  }

  async stopExecution(
    projectId: string,
    taskId?: string,
    sessionId?: string,
  ): Promise<{ stopped: boolean }> {
    if (taskId) {
      const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, sessionId);
      const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
      const matched = plan?.tasks.find((t) => t.id === taskId || t.externalId === taskId);
      const targetId = matched?.id ?? taskId;
      const active = this.activeTasks.get(targetId);
      if (!active || active.projectId !== projectId) {
        return { stopped: false };
      }
      active.controller.abort();
      await active.promise.catch(() => undefined);
      return { stopped: true };
    }

    const queue = this.projectQueues.get(projectId);
    const matchingQueue = queue && (!sessionId || queue.sessionId === sessionId) ? queue : undefined;
    const activeList = this.getActiveTasksForProject(projectId).filter(
      (a) => !sessionId || a.sessionId === sessionId,
    );
    if (!matchingQueue && activeList.length === 0) {
      return { stopped: false };
    }

    if (matchingQueue) {
      matchingQueue.cancelled = true;
      matchingQueue.controller.abort();
      matchingQueue.wake();
    }
    for (const active of activeList) {
      active.controller.abort();
    }

    if (!sessionId) {
      await this.waitForProjectExecution(projectId);
    } else {
      await Promise.all([
        matchingQueue?.promise.catch(() => undefined),
        ...activeList.map((t) => t.promise.catch(() => undefined)),
      ]);
    }
    return { stopped: true };
  }

  async stopAll(): Promise<void> {
    const projectIds = new Set<string>([
      ...this.projectQueues.keys(),
      ...[...this.activeTasks.values()].map((t) => t.projectId),
    ]);
    await Promise.all([...projectIds].map((pid) => this.stopExecution(pid)));
  }

  private async launchTaskExecution(
    projectId: string,
    sessionId: string,
    task: TaskDTO,
    execHandle: ActiveTaskExecution,
    opts: { resumeSessionId: string | null; preAcquiredLease: SlotLease | null },
  ): Promise<{ initialRun: TaskRunDTO; completionPromise: Promise<RunStatus> }> {
    const { runId, initialRun, executeFn } = await this.prepareTaskExecution(
      projectId,
      sessionId,
      task,
      execHandle,
      opts.resumeSessionId,
      opts.preAcquiredLease,
    );
    execHandle.runId = runId;
    execHandle.taskId = task.id;
    execHandle.sessionId = sessionId;

    const completionPromise = (async (): Promise<RunStatus> => {
      try {
        return await executeFn();
      } catch (err) {
        this.events?.emitEvent({
          type: 'run.finished',
          projectId,
          sessionId,
          taskId: execHandle.taskId,
          runId: execHandle.runId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return 'failed';
      } finally {
        if (this.activeTasks.get(task.id) === execHandle) {
          this.activeTasks.delete(task.id);
        }
        const stillActive =
          [...this.activeTasks.values()].some((a) => a.sessionId === sessionId) ||
          Boolean(
            this.projectQueues.get(projectId)?.sessionId === sessionId &&
              !this.projectQueues.get(projectId)?.cancelled,
          );
        this.leadService.reconcileSessionWorkState(sessionId, stillActive);
      }
    })();

    execHandle.promise = completionPromise;
    return { initialRun, completionPromise };
  }

  private insertRunRecord(input: {
    id: string;
    projectId: string;
    taskId: string;
    profileId: string;
    provider: ProviderId;
    accountKey: string;
    model: string | null;
    kind: RunKind;
    branchName: string;
    worktreePath: string;
    cliSessionId: string | null;
    attempt: number;
    usedFallback: boolean;
    commitBefore: string;
    checkpointBeforeRef?: string | null;
    logPath: string;
  }): typeof runs.$inferSelect {
    const now = new Date().toISOString();
    this.db
      .insert(runs)
      .values({
        id: input.id,
        projectId: input.projectId,
        taskId: input.taskId,
        profileId: input.profileId,
        provider: input.provider,
        accountKey: input.accountKey,
        model: input.model,
        kind: input.kind,
        branchName: input.branchName,
        worktreePath: input.worktreePath,
        status: 'running',
        cliSessionId: input.cliSessionId,
        attempt: input.attempt,
        usedFallback: input.usedFallback,
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        failureReason: null,
        commitBefore: input.commitBefore,
        commitAfter: null,
        checkpointBeforeRef: input.checkpointBeforeRef ?? null,
        checkpointAfterRef: null,
        logPath: input.logPath,
        resultPath: null,
        scopeWarningsJson: '[]',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        estimatedCostUsd: null,
        costSource: null,
      })
      .run();
    return this.db.select().from(runs).where(eq(runs.id, input.id)).get()!;
  }

  private nextAttemptForTask(taskId: string): number {
    return (
      this.db
        .select()
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .all().length + 1
    );
  }

  private async prepareTaskExecution(
    projectId: string,
    sessionId: string,
    task: TaskDTO,
    execHandle: ActiveTaskExecution,
    resumeSessionId: string | null,
    preAcquiredLease: SlotLease | null,
  ): Promise<{
    runId: string;
    initialRun: TaskRunDTO;
    executeFn: () => Promise<RunStatus>;
  }> {
    const project = this.getProjectRow(projectId);
    const sandboxReady = await this.registry.isSandboxReady();
    const routing = this.routeTask(task, sandboxReady);
    if (routing.blocked) throw new Error(routing.blocked);

    const branchName = `dalang/${task.externalId}`;
    const worktreePath = getTaskWorktreeDir(this.worktreesRoot, projectId, task.externalId);
    const resetToBase = !resumeSessionId || !(await branchExists(project.path, branchName));

    const { baseMainSha, checkpointRef: baselineCheckpointRef } = await this.withProjectGitLock(
      projectId,
      async () => {
        const baseline = await ensureMainBaseline(project.path, project.mainBranch);
        await createTaskWorktree(
          project.path,
          worktreePath,
          branchName,
          project.mainBranch,
          resetToBase,
        );
        return baseline;
      },
    );

    const logsDir = sessionId
      ? getSessionLogsDir(project.path, sessionId)
      : getProjectLogsDir(project.path);
    ensureProjectDir(project.path, logsDir);

    const taskArtDir = sessionId
      ? getSessionTaskArtifactDir(worktreePath, sessionId, task.externalId)
      : getTaskArtifactDir(worktreePath, task.externalId);
    ensureProjectDir(worktreePath, taskArtDir);

    const relTaskDir = sessionId
      ? path.posix.join('.dalang', 'sessions', sessionId, 'tasks', task.externalId)
      : path.posix.join('.dalang', 'tasks', task.externalId);
    const relLogsDir = sessionId
      ? path.posix.join('.dalang', 'sessions', sessionId, 'logs')
      : path.posix.join('.dalang', 'logs');

    const relResultPath = path.posix.join(relTaskDir, 'result.json');
    const absResultPath = path.join(worktreePath, relResultPath);
    const relReviewPath = path.posix.join(relTaskDir, 'review.json');
    const absReviewPath = path.join(worktreePath, relReviewPath);

    // Clear stale outputs before running so only files written in this execution count.
    removeArtifactFile(worktreePath, absResultPath);
    if (!resumeSessionId) {
      removeArtifactFile(worktreePath, absReviewPath);
    }

    if (routing.proactiveFallback && routing.quotaReroutedReason) {
      this.recordProviderEvent(
        routing.skippedPrimaryProvider ?? routing.primary.provider,
        'quota_fallback',
        routing.quotaReroutedReason,
        routing.skippedPrimaryConfigDir,
      );
    }

    const priorRejectionNote = task.rejectionNote ?? null;
    const runId = crypto.randomUUID();
    const attempt = this.nextAttemptForTask(task.id);
    const relLogPath = path.join(relLogsDir, `run-${task.externalId}-${Date.now()}.log`);
    const absLogPath = path.join(project.path, relLogPath);

    const row = this.insertRunRecord({
      id: runId,
      projectId,
      taskId: task.id,
      profileId: routing.primary.id,
      provider: routing.primary.provider,
      accountKey: buildAccountKey(routing.primary.provider, routing.primary.configDir),
      model: routing.primary.model || null,
      kind: 'execute',
      branchName,
      worktreePath,
      cliSessionId: resumeSessionId,
      attempt,
      usedFallback: routing.proactiveFallback,
      commitBefore: baseMainSha,
      checkpointBeforeRef: baselineCheckpointRef,
      logPath: relLogPath,
    });
    execHandle.runId = runId;
    execHandle.taskId = task.id;
    execHandle.sessionId = sessionId;

    const now = new Date().toISOString();
    this.db
      .update(tasks)
      .set({
        status: 'running',
        branchName,
        mergeCommitSha: null,
        ...(resumeSessionId ? {} : { reviewRounds: 0, rejectionNote: null }),
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))
      .run();

    this.events?.emitEvent({
      type: 'run.started',
      projectId,
      sessionId,
      taskId: task.id,
      runId,
      profileName: routing.primary.name,
      provider: routing.primary.provider,
    });
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId });

    const initialRun = await this.toRunDTO(project.path, row, task, routing.primary);

    const executeFn = async (): Promise<RunStatus> => {
      return this.executePreparedRun({
        projectId,
        sessionId,
        projectPath: project.path,
        worktreePath,
        mainBranch: project.mainBranch,
        branchName,
        baseMainSha,
        task,
        priorRejectionNote,
        execHandle,
        initialRunId: runId,
        initialProfile: routing.primary,
        fallbackProfile: routing.fallback,
        initialLease: preAcquiredLease,
        sandboxReady,
        routeNote: routing.note,
        attempt,
        absLogPath,
        relLogPath,
        relLogsDir,
        relTaskDir,
        absResultPath,
        relResultPath,
        absReviewPath,
        relReviewPath,
        resumeSessionId,
      });
    };

    return { runId, initialRun, executeFn };
  }

  private async executePreparedRun(ctx: {
    projectId: string;
    sessionId: string;
    projectPath: string;
    worktreePath: string;
    mainBranch: string;
    branchName: string;
    baseMainSha: string;
    task: TaskDTO;
    priorRejectionNote: string | null;
    execHandle: ActiveTaskExecution;
    initialRunId: string;
    initialProfile: AgentProfileDTO;
    fallbackProfile: AgentProfileDTO | null;
    initialLease: SlotLease | null;
    sandboxReady: boolean;
    routeNote: string | null;
    attempt: number;
    absLogPath: string;
    relLogPath: string;
    relLogsDir: string;
    relTaskDir: string;
    absResultPath: string;
    relResultPath: string;
    absReviewPath: string;
    relReviewPath: string;
    resumeSessionId: string | null;
  }): Promise<RunStatus> {
    const coderOutcome = await this.runCoderPhaseWithFallback({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
      worktreePath: ctx.worktreePath,
      branchName: ctx.branchName,
      baseMainSha: ctx.baseMainSha,
      task: ctx.task,
      execHandle: ctx.execHandle,
      initialRunId: ctx.initialRunId,
      initialProfile: ctx.initialProfile,
      fallbackProfile: ctx.fallbackProfile,
      initialLease: ctx.initialLease,
      sandboxReady: ctx.sandboxReady,
      routeNote: ctx.routeNote,
      absLogPath: ctx.absLogPath,
      relLogsDir: ctx.relLogsDir,
      absResultPath: ctx.absResultPath,
      relResultPath: ctx.relResultPath,
      sessionToResume: ctx.resumeSessionId,
      kind: 'execute',
      prompt: ctx.resumeSessionId
        ? this.buildResumePrompt(ctx.task, ctx.relResultPath, ctx.priorRejectionNote)
        : this.buildTaskPrompt(ctx.task, ctx.initialProfile, ctx.relResultPath, ctx.priorRejectionNote),
      buildPromptForProfile: (prof) =>
        this.buildTaskPrompt(ctx.task, prof, ctx.relResultPath, ctx.priorRejectionNote),
    });

    if (coderOutcome.status !== 'completed') {
      return coderOutcome.status;
    }

    // Enter v0.3 Kawal review + fix loop inside the task's isolated worktree.
    return this.runReviewAndFixLoop({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
      worktreePath: ctx.worktreePath,
      mainBranch: ctx.mainBranch,
      branchName: ctx.branchName,
      baseMainSha: ctx.baseMainSha,
      task: ctx.task,
      execHandle: ctx.execHandle,
      sandboxReady: ctx.sandboxReady,
      coderProfile: coderOutcome.profile,
      coderFallback: coderOutcome.fallback,
      coderSessionId: coderOutcome.sessionId,
      coderResult: coderOutcome.result,
      scopeWarnings: coderOutcome.scopeWarnings,
      relLogsDir: ctx.relLogsDir,
      relTaskDir: ctx.relTaskDir,
      absResultPath: ctx.absResultPath,
      relResultPath: ctx.relResultPath,
      absReviewPath: ctx.absReviewPath,
      relReviewPath: ctx.relReviewPath,
    });
  }

  private async runCoderPhaseWithFallback(opts: {
    projectId: string;
    sessionId: string;
    projectPath: string;
    worktreePath: string;
    branchName: string;
    baseMainSha: string;
    task: TaskDTO;
    execHandle: ActiveTaskExecution;
    initialRunId: string;
    initialProfile: AgentProfileDTO;
    fallbackProfile: AgentProfileDTO | null;
    initialLease: SlotLease | null;
    sandboxReady: boolean;
    routeNote: string | null;
    absLogPath: string;
    relLogsDir: string;
    absResultPath: string;
    relResultPath: string;
    sessionToResume: string | null;
    kind: 'execute' | 'fix';
    prompt: string;
    buildPromptForProfile: (profile: AgentProfileDTO) => string;
  }): Promise<{
    status: RunStatus;
    profile: AgentProfileDTO;
    fallback: AgentProfileDTO | null;
    sessionId: string | null;
    commitAfter: string;
    result: TaskResultContract | null;
    scopeWarnings: string[];
  }> {
    const runAttempt = async (
      runId: string,
      profile: AgentProfileDTO,
      logFileAbs: string,
      sessionToResume: string | null,
      promptText: string,
      preLease: SlotLease | null,
    ): Promise<{
      status: RunStatus;
      canFallback: boolean;
      sessionId: string | null;
      commitAfter: string;
      result: TaskResultContract | null;
      scopeWarnings: string[];
      failureReason?: string;
    }> => {
      const adapter = this.registry.getAdapter(profile.provider);
      const profileAccountKey = buildAccountKey(profile.provider, profile.configDir);
      let capturedSessionId: string | null = sessionToResume;
      let exitCode: number | null = null;
      let stdout = '';
      let stderr = '';
      let aborted = false;
      let thrownError: string | undefined;
      let rateLimitFromStream: string | undefined;
      let capturedUsage: TurnTokenUsage | undefined;

      const emitDalangLine = (line: string) => {
        this.appendDalangLog(logFileAbs, line);
        this.events?.emitEvent({
          type: 'run.log',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId,
          line,
        });
      };
      const emitAdapterLine = (line: string) => {
        this.events?.emitEvent({
          type: 'run.log',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId,
          line,
        });
      };

      const markRunStopped = async (): Promise<{
        status: RunStatus;
        canFallback: false;
        sessionId: string | null;
        commitAfter: string;
        result: null;
        scopeWarnings: string[];
      }> => {
        const hidden = await createHiddenCheckpointRef(
          opts.worktreePath,
          `stopped-${runId}`,
          `dalang: hidden checkpoint stopped ${opts.task.externalId}`,
          opts.projectPath,
        ).catch(() => ({ commitSha: opts.baseMainSha, refName: null as string | null }));
        const finishedAt = new Date().toISOString();
        const usageFields = usageDbFields(profile.provider, profile.model || null, capturedUsage);
        this.db
          .update(runs)
          .set({
            status: 'stopped',
            finishedAt,
            exitCode,
            failureReason: 'Stopped by user',
            commitAfter: hidden.commitSha,
            checkpointAfterRef: hidden.refName,
            ...usageFields,
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'stopped', updatedAt: finishedAt })
          .where(eq(tasks.id, opts.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId,
          status: 'stopped',
          error: 'Stopped by user',
        });
        this.events?.emitEvent({ type: 'plan.updated', projectId: opts.projectId });
        return {
          status: 'stopped',
          canFallback: false,
          sessionId: capturedSessionId,
          commitAfter: hidden.commitSha,
          result: null,
          scopeWarnings: [],
        };
      };

      let lease: SlotLease | null = preLease;
      let resultAlreadyValidated = false;
      try {
        if (!lease) {
          emitDalangLine(
            `[dalang] Waiting for parallel slot on ${profileAccountKey} (max ${profile.maxParallel})...`,
          );
          lease = await this.limiter.acquire(
            profileAccountKey,
            profile.maxParallel,
            opts.execHandle.controller.signal,
          );
        }

        emitDalangLine(
          `[dalang] Starting ${opts.kind} for ${opts.task.externalId} (${opts.task.title}) in worktree (${opts.branchName}) with profile "${profile.name}" (${profile.provider}${profile.model ? `/${profile.model}` : ''})`,
        );
        if (opts.routeNote) emitDalangLine(`[dalang] ${opts.routeNote}`);

        const turn = await adapter.runTurn({
          projectPath: opts.worktreePath,
          prompt: promptText,
          sessionId: sessionToResume,
          model: profile.model || null,
          effort: profile.effort,
          permissionMode: writePermission(profile),
          configDir: profile.configDir,
          timeoutMs: profile.timeoutMs,
          idleTimeoutMs: profile.idleTimeoutMs,
          signal: opts.execHandle.controller.signal,
          logFilePath: logFileAbs,
          onLogLine: emitAdapterLine,
        });

        capturedSessionId = turn.sessionId ?? capturedSessionId;
        exitCode = turn.exitCode;
        stdout = turn.stdout;
        stderr = turn.stderr;
        aborted = Boolean(turn.aborted) || opts.execHandle.controller.signal.aborted;
        rateLimitFromStream = turn.rateLimitReason;
        capturedUsage = mergeTokenUsage(capturedUsage, turn.usage);

        if (capturedSessionId) {
          this.db
            .update(runs)
            .set({ cliSessionId: capturedSessionId })
            .where(eq(runs.id, runId))
            .run();
        }

        if (!aborted && !thrownError && (exitCode === null || exitCode === 0) && !rateLimitFromStream) {
          const firstCheck = this.validateResultFile(
            opts.worktreePath,
            opts.absResultPath,
            opts.task.externalId,
          );
          if (!firstCheck.ok && !opts.execHandle.controller.signal.aborted) {
            emitDalangLine(
              `[dalang] ${firstCheck.error}; requesting structured result.json repair...`,
            );
            const jsonSchema = z.toJSONSchema(TaskResultContractSchema);
            const repairPrompt = [
              `Your task work finished, but the required contract file failed validation:`,
              firstCheck.error,
              ``,
              `Please write a valid JSON file directly to "${opts.relResultPath}" matching this JSON Schema:`,
              JSON.stringify(jsonSchema, null, 2),
            ].join('\n');

            const repairTurn = await adapter.runTurn({
              projectPath: opts.worktreePath,
              prompt: repairPrompt,
              sessionId: capturedSessionId,
              model: profile.model || null,
              effort: profile.effort,
              permissionMode: writePermission(profile),
              configDir: profile.configDir,
              timeoutMs: Math.min(profile.timeoutMs, 180_000),
              idleTimeoutMs: profile.idleTimeoutMs,
              signal: opts.execHandle.controller.signal,
              logFilePath: logFileAbs,
              onLogLine: emitAdapterLine,
            });
            capturedUsage = mergeTokenUsage(capturedUsage, repairTurn.usage);
            if (repairTurn.sessionId) {
              capturedSessionId = repairTurn.sessionId;
              this.db
                .update(runs)
                .set({ cliSessionId: capturedSessionId })
                .where(eq(runs.id, runId))
                .run();
            }
            if (repairTurn.aborted || opts.execHandle.controller.signal.aborted) {
              aborted = true;
            }
            if (repairTurn.exitCode !== null && repairTurn.exitCode !== 0) {
              exitCode = repairTurn.exitCode;
              stdout = repairTurn.stdout;
              stderr = repairTurn.stderr;
            }
            if (repairTurn.rateLimitReason) {
              rateLimitFromStream = repairTurn.rateLimitReason;
            }
          } else {
            resultAlreadyValidated = true;
          }
        }
      } catch (err) {
        aborted = opts.execHandle.controller.signal.aborted;
        if (!aborted) {
          thrownError = err instanceof Error ? err.message : String(err);
          emitDalangLine(`[dalang:error] ${thrownError}`);
        }
      } finally {
        lease?.release();
      }

      if (aborted) return markRunStopped();

      if (thrownError || rateLimitFromStream || (exitCode !== null && exitCode !== 0)) {
        const classified = rateLimitFromStream
          ? { eventType: 'rate_limit' as const, reason: rateLimitFromStream }
          : classifyProviderFailure(exitCode, stdout, stderr, thrownError);
        this.recordProviderEvent(profile.provider, classified.eventType, classified.reason, profile.configDir);

        const hidden = await createHiddenCheckpointRef(
          opts.worktreePath,
          `failed-${runId}`,
          `dalang: hidden checkpoint failed ${opts.task.externalId}`,
          opts.projectPath,
        ).catch(() => ({ commitSha: opts.baseMainSha, refName: null as string | null }));
        const finishedAt = new Date().toISOString();
        const usageFields = usageDbFields(profile.provider, profile.model || null, capturedUsage);
        this.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt,
            exitCode,
            failureReason: classified.reason,
            commitAfter: hidden.commitSha,
            checkpointAfterRef: hidden.refName,
            ...usageFields,
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'failed', updatedAt: finishedAt })
          .where(eq(tasks.id, opts.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId,
          status: 'failed',
          error: classified.reason,
        });
        this.events?.emitEvent({ type: 'plan.updated', projectId: opts.projectId });

        return {
          status: 'failed',
          canFallback: true,
          sessionId: capturedSessionId,
          commitAfter: hidden.commitSha,
          result: null,
          scopeWarnings: [],
          failureReason: classified.reason,
        };
      }

      const validation = this.validateResultFile(
        opts.worktreePath,
        opts.absResultPath,
        opts.task.externalId,
      );
      void resultAlreadyValidated;

      let scopeWarnings: string[];
      try {
        const changedFiles = await getChangedFilesBetween(
          opts.worktreePath,
          opts.baseMainSha,
          null,
          opts.projectPath,
        );
        scopeWarnings = findScopeViolations(changedFiles, opts.task.filesAllowed);
      } catch (err) {
        scopeWarnings = [
          `Could not verify files_allowed: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
      for (const warn of scopeWarnings) {
        emitDalangLine(`[dalang:warn] ${warn}`);
      }

      if (!validation.ok) {
        const hidden = await createHiddenCheckpointRef(
          opts.worktreePath,
          `invalid-${runId}`,
          `dalang: hidden checkpoint invalid-result ${opts.task.externalId}`,
          opts.projectPath,
        ).catch(() => ({ commitSha: opts.baseMainSha, refName: null as string | null }));
        const finishedAt = new Date().toISOString();
        const usageFields = usageDbFields(profile.provider, profile.model || null, capturedUsage);
        this.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt,
            exitCode,
            failureReason: validation.error,
            commitAfter: hidden.commitSha,
            checkpointAfterRef: hidden.refName,
            scopeWarningsJson: JSON.stringify(scopeWarnings),
            ...usageFields,
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'failed', updatedAt: finishedAt })
          .where(eq(tasks.id, opts.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId,
          status: 'failed',
          error: validation.error,
        });
        this.events?.emitEvent({ type: 'plan.updated', projectId: opts.projectId });
        return {
          status: 'failed',
          canFallback: false,
          sessionId: capturedSessionId,
          commitAfter: hidden.commitSha,
          result: null,
          scopeWarnings,
          failureReason: validation.error,
        };
      }

      const resultData = validation.data;
      const succeeded = resultData.status === 'completed';
      const finalRunStatus: RunStatus = succeeded ? 'completed' : 'failed';
      const failureReason = succeeded
        ? null
        : resultData.blockers.join('; ') || `Task reported status "${resultData.status}"`;

      const checkpointAfter = await createGitCheckpoint(
        opts.worktreePath,
        `dalang: ${opts.task.externalId} (${opts.kind} ${succeeded ? 'completed' : 'failed'})`,
        opts.projectPath,
      );
      const hiddenAfter = await createHiddenCheckpointRef(
        opts.worktreePath,
        `after-${runId}`,
        `dalang: hidden checkpoint ${opts.task.externalId} (${opts.kind} ${finalRunStatus})`,
        opts.projectPath,
      ).catch(() => null);
      const finishedAt = new Date().toISOString();
      const usageFields = usageDbFields(profile.provider, profile.model || null, capturedUsage);

      this.db
        .update(runs)
        .set({
          status: finalRunStatus,
          finishedAt,
          exitCode,
          failureReason,
          commitAfter: checkpointAfter.commitSha,
          checkpointAfterRef: hiddenAfter?.refName ?? null,
          resultPath: opts.relResultPath,
          scopeWarningsJson: JSON.stringify(scopeWarnings),
          ...usageFields,
        })
        .where(eq(runs.id, runId))
        .run();

      if (!succeeded) {
        this.db
          .update(tasks)
          .set({ status: 'failed', updatedAt: finishedAt })
          .where(eq(tasks.id, opts.task.id))
          .run();
      }

      emitDalangLine(
        `[dalang] Finished ${opts.kind} for ${opts.task.externalId} -> ${finalRunStatus} (checkpoint ${checkpointAfter.commitSha.slice(0, 7)})`,
      );
      this.events?.emitEvent({
        type: 'run.finished',
        projectId: opts.projectId,
        taskId: opts.task.id,
        runId,
        status: finalRunStatus,
        ...(failureReason ? { error: failureReason } : {}),
      });
      this.events?.emitEvent({ type: 'plan.updated', projectId: opts.projectId });

      return {
        status: finalRunStatus,
        canFallback: false,
        sessionId: capturedSessionId,
        commitAfter: checkpointAfter.commitSha,
        result: resultData,
        scopeWarnings,
        failureReason: failureReason ?? undefined,
      };
    };

    const primaryOutcome = await runAttempt(
      opts.initialRunId,
      opts.initialProfile,
      opts.absLogPath,
      opts.sessionToResume,
      opts.prompt,
      opts.initialLease,
    );

    if (
      primaryOutcome.status === 'failed' &&
      primaryOutcome.canFallback &&
      opts.fallbackProfile &&
      !opts.execHandle.controller.signal.aborted &&
      this.evaluateProviderUsability(
        opts.fallbackProfile.provider,
        opts.fallbackProfile.model || null,
        opts.sandboxReady,
        opts.fallbackProfile.configDir,
      ).usable
    ) {
      const fbRunId = crypto.randomUUID();
      const fbRelLog = path.join(
        opts.relLogsDir,
        `run-${opts.task.externalId}-fb-${Date.now()}.log`,
      );
      const fbAbsLog = path.join(opts.projectPath, fbRelLog);
      removeArtifactFile(opts.worktreePath, opts.absResultPath);

      this.insertRunRecord({
        id: fbRunId,
        projectId: opts.projectId,
        taskId: opts.task.id,
        profileId: opts.fallbackProfile.id,
        provider: opts.fallbackProfile.provider,
        accountKey: buildAccountKey(opts.fallbackProfile.provider, opts.fallbackProfile.configDir),
        model: opts.fallbackProfile.model || null,
        kind: opts.kind,
        branchName: opts.branchName,
        worktreePath: opts.worktreePath,
        cliSessionId: null,
        attempt: this.nextAttemptForTask(opts.task.id),
        usedFallback: true,
        commitBefore: opts.baseMainSha,
        logPath: fbRelLog,
      });

      this.db
        .update(tasks)
        .set({ status: 'running', updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, opts.task.id))
        .run();

      opts.execHandle.runId = fbRunId;
      this.events?.emitEvent({
        type: 'run.started',
        projectId: opts.projectId,
        taskId: opts.task.id,
        runId: fbRunId,
        profileName: opts.fallbackProfile.name,
        provider: opts.fallbackProfile.provider,
      });
      const fallbackBanner = `[dalang] Fallback triggered after ${opts.initialProfile.name} failed (${primaryOutcome.failureReason ?? 'error'}). Switching to ${routeLabel(opts.fallbackProfile)}.`;
      this.recordProviderEvent(
        opts.initialProfile.provider,
        'quota_fallback',
        fallbackBanner,
        opts.initialProfile.configDir,
      );
      this.appendDalangLog(fbAbsLog, fallbackBanner);
      this.events?.emitEvent({
        type: 'run.log',
        projectId: opts.projectId,
        taskId: opts.task.id,
        runId: fbRunId,
        line: fallbackBanner,
      });
      this.events?.emitEvent({ type: 'plan.updated', projectId: opts.projectId });

      const fbOutcome = await runAttempt(
        fbRunId,
        opts.fallbackProfile,
        fbAbsLog,
        null,
        opts.buildPromptForProfile(opts.fallbackProfile),
        null,
      );
      return {
        status: fbOutcome.status,
        profile: opts.fallbackProfile,
        fallback: null,
        sessionId: fbOutcome.sessionId,
        commitAfter: fbOutcome.commitAfter,
        result: fbOutcome.result,
        scopeWarnings: fbOutcome.scopeWarnings,
      };
    }

    return {
      status: primaryOutcome.status,
      profile: opts.initialProfile,
      fallback: opts.fallbackProfile,
      sessionId: primaryOutcome.sessionId,
      commitAfter: primaryOutcome.commitAfter,
      result: primaryOutcome.result,
      scopeWarnings: primaryOutcome.scopeWarnings,
    };
  }

  private resolveUsableReviewer(
    coderProvider: ProviderId,
    sandboxReady: boolean,
  ): ReturnType<ProfileService['resolveReviewerProfile']> {
    const resolved = this.profiles.resolveReviewerProfile({
      coderProvider,
      sandboxReady,
      registry: this.registry,
    });
    if (resolved.blocked) return resolved;

    const primaryUsable = this.evaluateProviderUsability(
      resolved.primary.provider,
      resolved.primary.model || null,
      sandboxReady,
      resolved.primary.configDir,
    );
    if (primaryUsable.usable) return resolved;

    if (resolved.fallback) {
      const fbUsable = this.evaluateProviderUsability(
        resolved.fallback.provider,
        resolved.fallback.model || null,
        sandboxReady,
        resolved.fallback.configDir,
      );
      if (fbUsable.usable) {
        return {
          primary: resolved.fallback,
          fallback: null,
          note: `${resolved.primary.name} (${resolved.primary.provider}) skipped (${primaryUsable.reason}); reviewing with ${routeLabel(resolved.fallback)}.`,
          blocked: null,
        };
      }
    }

    const anyUsable = this.profiles
      .listProfiles()
      .find((p) => this.evaluateProviderUsability(p.provider, p.model || null, sandboxReady, p.configDir).usable);
    if (anyUsable) {
      return {
        primary: { ...anyUsable, permissionMode: 'read-only' },
        fallback: null,
        note: `${resolved.primary.name} (${resolved.primary.provider}) skipped (${primaryUsable.reason}); reviewing with ${anyUsable.name} (${anyUsable.provider}).`,
        blocked: null,
      };
    }

    return {
      ...resolved,
      blocked: primaryUsable.reason ?? 'No usable reviewer profile is available.',
    };
  }

  private async runReviewAndFixLoop(ctx: {
    projectId: string;
    sessionId: string;
    projectPath: string;
    worktreePath: string;
    mainBranch: string;
    branchName: string;
    baseMainSha: string;
    task: TaskDTO;
    execHandle: ActiveTaskExecution;
    sandboxReady: boolean;
    coderProfile: AgentProfileDTO;
    coderFallback: AgentProfileDTO | null;
    coderSessionId: string | null;
    coderResult: TaskResultContract | null;
    scopeWarnings: string[];
    relLogsDir: string;
    relTaskDir: string;
    absResultPath: string;
    relResultPath: string;
    absReviewPath: string;
    relReviewPath: string;
  }): Promise<RunStatus> {
    let activeCoderProfile = ctx.coderProfile;
    let activeCoderFallback = ctx.coderFallback;
    let activeCoderSessionId = ctx.coderSessionId;
    let activeCoderResult = ctx.coderResult;
    let activeScopeWarnings = ctx.scopeWarnings;

    const initialReviewer = this.resolveUsableReviewer(activeCoderProfile.provider, ctx.sandboxReady);
    if (initialReviewer.blocked) {
      const now = new Date().toISOString();
      this.db
        .update(tasks)
        .set({
          status: 'review_failed',
          rejectionNote: initialReviewer.blocked,
          updatedAt: now,
        })
        .where(eq(tasks.id, ctx.task.id))
        .run();
      this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
      return 'failed';
    }

    const maxRounds = Math.min(3, Math.max(1, initialReviewer.primary.maxReviewRounds || 2));

    for (let round = 1; round <= maxRounds; round++) {
      if (ctx.execHandle.controller.signal.aborted) {
        return 'stopped';
      }

      const reviewerRouting = this.resolveUsableReviewer(activeCoderProfile.provider, ctx.sandboxReady);
      if (reviewerRouting.blocked) {
        this.db
          .update(tasks)
          .set({
            status: 'review_failed',
            rejectionNote: reviewerRouting.blocked,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
        return 'failed';
      }

      this.db
        .update(tasks)
        .set({ status: 'reviewing', updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, ctx.task.id))
        .run();
      this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });

      const currentHead = (await getHeadCommit(ctx.worktreePath)) ?? ctx.baseMainSha;
      let changedFiles: string[] = [];
      try {
        changedFiles = await getChangedFilesBetween(
          ctx.worktreePath,
          ctx.baseMainSha,
          currentHead,
          ctx.projectPath,
        );
        activeScopeWarnings = findScopeViolations(changedFiles, ctx.task.filesAllowed);
      } catch (err) {
        activeScopeWarnings = [
          `Could not verify files_allowed: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
      const diffData = await getTaskDiff(
        ctx.projectPath,
        ctx.task.id,
        ctx.task.externalId,
        ctx.branchName,
        ctx.baseMainSha,
        currentHead,
      ).catch(() => null);

      const reviewOutcome = await this.executeSingleReviewRound({
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        projectPath: ctx.projectPath,
        worktreePath: ctx.worktreePath,
        branchName: ctx.branchName,
        baseMainSha: ctx.baseMainSha,
        currentHead,
        task: ctx.task,
        round,
        maxRounds,
        execHandle: ctx.execHandle,
        sandboxReady: ctx.sandboxReady,
        primaryReviewer: reviewerRouting.primary,
        fallbackReviewer: reviewerRouting.fallback,
        routeNote: reviewerRouting.note,
        changedFiles,
        scopeWarnings: activeScopeWarnings,
        rawDiff: diffData?.rawDiff ?? '',
        coderResult: activeCoderResult,
        relLogsDir: ctx.relLogsDir,
        relTaskDir: ctx.relTaskDir,
        absReviewPath: ctx.absReviewPath,
        relReviewPath: ctx.relReviewPath,
      });

      if (reviewOutcome.status === 'stopped') {
        return 'stopped';
      }
      if (reviewOutcome.status === 'failed' || !reviewOutcome.contract) {
        this.db
          .update(tasks)
          .set({
            status: 'review_failed',
            rejectionNote: reviewOutcome.error ?? 'Reviewer failed to produce a valid review.',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
        return 'failed';
      }

      const reviewData = reviewOutcome.contract;
      if (reviewData.status === 'pass') {
        this.db
          .update(tasks)
          .set({
            status: 'awaiting_merge',
            reviewRounds: round,
            rejectionNote: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
        return 'completed';
      }

      if (round >= maxRounds) {
        this.db
          .update(tasks)
          .set({
            status: 'review_failed',
            reviewRounds: round,
            rejectionNote:
              reviewData.findings[0]?.note ??
              `Review failed after ${round} round(s).`,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
        return 'failed';
      }

      // Check coder profile quota/cooldown before starting fix round.
      const coderUsability = this.evaluateProviderUsability(
        activeCoderProfile.provider,
        activeCoderProfile.model || null,
        ctx.sandboxReady,
        activeCoderProfile.configDir,
      );
      let usedProactiveFixFallback = false;
      let fixNote = `Fix round ${round} addressing ${reviewData.findings.length} review finding(s).`;
      if (!coderUsability.usable && activeCoderFallback) {
        const fbUsability = this.evaluateProviderUsability(
          activeCoderFallback.provider,
          activeCoderFallback.model || null,
          ctx.sandboxReady,
          activeCoderFallback.configDir,
        );
        if (fbUsability.usable) {
          fixNote = `Fix round ${round}: ${activeCoderProfile.name} skipped (${coderUsability.reason}); switched to ${routeLabel(activeCoderFallback)}.`;
          this.recordProviderEvent(
            activeCoderProfile.provider,
            'quota_fallback',
            fixNote,
            activeCoderProfile.configDir,
          );
          activeCoderProfile = activeCoderFallback;
          activeCoderFallback = null;
          activeCoderSessionId = null;
          usedProactiveFixFallback = true;
        }
      }

      // Send review findings back to the coder for an automatic fix round (F-18).
      removeArtifactFile(ctx.worktreePath, ctx.absResultPath);
      const fixRunId = crypto.randomUUID();
      const fixRelLog = path.join(
        ctx.relLogsDir,
        `fix-${ctx.task.externalId}-r${round}-${Date.now()}.log`,
      );
      const fixAbsLog = path.join(ctx.projectPath, fixRelLog);

      this.insertRunRecord({
        id: fixRunId,
        projectId: ctx.projectId,
        taskId: ctx.task.id,
        profileId: activeCoderProfile.id,
        provider: activeCoderProfile.provider,
        accountKey: buildAccountKey(activeCoderProfile.provider, activeCoderProfile.configDir),
        model: activeCoderProfile.model || null,
        kind: 'fix',
        branchName: ctx.branchName,
        worktreePath: ctx.worktreePath,
        cliSessionId: activeCoderSessionId,
        attempt: this.nextAttemptForTask(ctx.task.id),
        usedFallback: usedProactiveFixFallback,
        commitBefore: ctx.baseMainSha,
        logPath: fixRelLog,
      });

      this.db
        .update(tasks)
        .set({ status: 'running', updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, ctx.task.id))
        .run();

      ctx.execHandle.runId = fixRunId;
      this.events?.emitEvent({
        type: 'run.started',
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        taskId: ctx.task.id,
        runId: fixRunId,
        profileName: activeCoderProfile.name,
        provider: activeCoderProfile.provider,
      });
      this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId, sessionId: ctx.sessionId });

      const fixOutcome = await this.runCoderPhaseWithFallback({
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        projectPath: ctx.projectPath,
        worktreePath: ctx.worktreePath,
        branchName: ctx.branchName,
        baseMainSha: ctx.baseMainSha,
        task: ctx.task,
        execHandle: ctx.execHandle,
        initialRunId: fixRunId,
        initialProfile: activeCoderProfile,
        fallbackProfile: activeCoderFallback,
        initialLease: null,
        sandboxReady: ctx.sandboxReady,
        routeNote: fixNote,
        absLogPath: fixAbsLog,
        relLogsDir: ctx.relLogsDir,
        absResultPath: ctx.absResultPath,
        relResultPath: ctx.relResultPath,
        sessionToResume: activeCoderSessionId,
        kind: 'fix',
        prompt: buildFixPrompt({
          task: ctx.task,
          profile: activeCoderProfile,
          relResultPath: ctx.relResultPath,
          round,
          review: reviewData,
          verifyOutput: reviewOutcome.verifyOutput,
          scopeWarnings: activeScopeWarnings,
        }),
        buildPromptForProfile: (prof) =>
          buildFixPrompt({
            task: ctx.task,
            profile: prof,
            relResultPath: ctx.relResultPath,
            round,
            review: reviewData,
            verifyOutput: reviewOutcome.verifyOutput,
            scopeWarnings: activeScopeWarnings,
          }),
      });

      if (fixOutcome.status !== 'completed') {
        return fixOutcome.status;
      }

      activeCoderProfile = fixOutcome.profile;
      activeCoderFallback = fixOutcome.fallback;
      activeCoderSessionId = fixOutcome.sessionId;
      activeCoderResult = fixOutcome.result;
      activeScopeWarnings = fixOutcome.scopeWarnings;
    }

    return 'failed';
  }

  private async executeSingleReviewRound(opts: {
    projectId: string;
    sessionId: string;
    projectPath: string;
    worktreePath: string;
    branchName: string;
    baseMainSha: string;
    currentHead: string;
    task: TaskDTO;
    round: number;
    maxRounds: number;
    execHandle: ActiveTaskExecution;
    sandboxReady: boolean;
    primaryReviewer: AgentProfileDTO;
    fallbackReviewer: AgentProfileDTO | null;
    routeNote: string | null;
    changedFiles: string[];
    scopeWarnings: string[];
    rawDiff: string;
    coderResult: TaskResultContract | null;
    relLogsDir: string;
    relTaskDir: string;
    absReviewPath: string;
    relReviewPath: string;
  }): Promise<{
    status: 'completed' | 'failed' | 'stopped';
    contract?: ReviewContract;
    verifyOutput: string;
    error?: string;
  }> {
    const runAttempt = async (
      reviewerProfile: AgentProfileDTO,
      usedFallback: boolean,
      verifyInfo?: { exitCode: number; output: string },
    ): Promise<{
      status: 'completed' | 'failed' | 'stopped';
      canFallback: boolean;
      contract?: ReviewContract;
      verifyExitCode: number;
      verifyOutput: string;
      error?: string;
    }> => {
      const reviewRunId = crypto.randomUUID();
      const relLogPath = path.join(
        opts.relLogsDir,
        `review-${opts.task.externalId}-r${opts.round}-${Date.now()}.log`,
      );
      const absLogPath = path.join(opts.projectPath, relLogPath);
      removeArtifactFile(opts.worktreePath, opts.absReviewPath);

      const reviewerAccountKey = buildAccountKey(reviewerProfile.provider, reviewerProfile.configDir);
      this.insertRunRecord({
        id: reviewRunId,
        projectId: opts.projectId,
        taskId: opts.task.id,
        profileId: reviewerProfile.id,
        provider: reviewerProfile.provider,
        accountKey: reviewerAccountKey,
        model: reviewerProfile.model || null,
        kind: 'review',
        branchName: opts.branchName,
        worktreePath: opts.worktreePath,
        cliSessionId: null,
        attempt: this.nextAttemptForTask(opts.task.id),
        usedFallback,
        commitBefore: opts.currentHead,
        logPath: relLogPath,
      });

      opts.execHandle.runId = reviewRunId;
      this.events?.emitEvent({
        type: 'run.started',
        projectId: opts.projectId,
        taskId: opts.task.id,
        runId: reviewRunId,
        profileName: reviewerProfile.name,
        provider: reviewerProfile.provider,
      });

      const emitDalangLine = (line: string) => {
        this.appendDalangLog(absLogPath, line);
        this.events?.emitEvent({
          type: 'run.log',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId: reviewRunId,
          line,
        });
      };
      const emitAdapterLine = (line: string) => {
        this.events?.emitEvent({
          type: 'run.log',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId: reviewRunId,
          line,
        });
      };

      emitDalangLine(
        `[dalang] Starting review round ${opts.round}/${opts.maxRounds} for ${opts.task.externalId} with profile "${reviewerProfile.name}" (${reviewerProfile.provider}, mode=${reviewerProfile.permissionMode})`,
      );
      if (opts.routeNote) emitDalangLine(`[dalang] ${opts.routeNote}`);

      let verifyExitCode = verifyInfo?.exitCode ?? 0;
      let verifyOutput = verifyInfo?.output ?? '';

      if (!verifyInfo) {
        emitDalangLine(`[dalang] Running verify command: ${opts.task.verify}`);
        try {
          const verifyRes = await this.registry.runShellCommand(opts.worktreePath, opts.task.verify, {
            timeoutMs: Math.min(reviewerProfile.timeoutMs, 300_000),
            idleTimeoutMs: reviewerProfile.idleTimeoutMs,
            signal: opts.execHandle.controller.signal,
            onLogLine: emitDalangLine,
          });
          if (verifyRes.aborted || opts.execHandle.controller.signal.aborted) {
            const finishedAt = new Date().toISOString();
            this.db
              .update(runs)
              .set({ status: 'stopped', finishedAt, failureReason: 'Stopped by user' })
              .where(eq(runs.id, reviewRunId))
              .run();
            this.db
              .update(tasks)
              .set({ status: 'stopped', updatedAt: finishedAt })
              .where(eq(tasks.id, opts.task.id))
              .run();
            this.events?.emitEvent({
              type: 'run.finished',
              projectId: opts.projectId,
              taskId: opts.task.id,
              runId: reviewRunId,
              status: 'stopped',
              error: 'Stopped by user',
            });
            return {
              status: 'stopped',
              canFallback: false,
              verifyExitCode: 1,
              verifyOutput: '',
            };
          }
          verifyExitCode =
            verifyRes.timedOut || verifyRes.idleTimedOut
              ? 124
              : (verifyRes.exitCode ?? 1);
          const combinedVerify = [verifyRes.stdout, verifyRes.stderr].filter(Boolean).join('\n');
          verifyOutput = tailOutput(
            verifyRes.timedOut || verifyRes.idleTimedOut
              ? `${combinedVerify}\n[dalang] Verify command timed out.`
              : combinedVerify,
          );
          emitDalangLine(`[dalang] Verify command exited with code ${verifyExitCode}`);
        } catch (err) {
          if (opts.execHandle.controller.signal.aborted) {
            const finishedAt = new Date().toISOString();
            this.db
              .update(runs)
              .set({ status: 'stopped', finishedAt, failureReason: 'Stopped by user' })
              .where(eq(runs.id, reviewRunId))
              .run();
            this.db
              .update(tasks)
              .set({ status: 'stopped', updatedAt: finishedAt })
              .where(eq(tasks.id, opts.task.id))
              .run();
            return { status: 'stopped', canFallback: false, verifyExitCode: 1, verifyOutput: '' };
          }
          verifyExitCode = 1;
          verifyOutput = err instanceof Error ? err.message : String(err);
          emitDalangLine(`[dalang:error] Verify execution failed: ${verifyOutput}`);
        }
      }

      const adapter = this.registry.getAdapter(reviewerProfile.provider);
      const isReadOnly = reviewerProfile.permissionMode === 'read-only';
      const initialPrompt = buildReviewPrompt({
        task: opts.task,
        profile: reviewerProfile,
        relReviewPath: opts.relReviewPath,
        round: opts.round,
        maxRounds: opts.maxRounds,
        verifyExitCode,
        verifyOutput,
        changedFiles: opts.changedFiles,
        scopeWarnings: opts.scopeWarnings,
        rawDiff: opts.rawDiff,
        coderResult: opts.coderResult,
        language: this.getLanguage(),
      });

      let currentSessionId: string | null = null;
      let currentPrompt = initialPrompt;
      let exitCode: number | null = null;
      let stdout = '';
      let stderr = '';
      let aborted = false;
      let thrownError: string | undefined;
      let rateLimitFromStream: string | undefined;
      let validatedContract: ReviewContract | null = null;
      let lastValidationError = 'Review output missing';
      let capturedUsage: TurnTokenUsage | undefined;

      let lease: SlotLease | null = null;
      try {
        lease = await this.limiter.acquire(
          reviewerAccountKey,
          reviewerProfile.maxParallel,
          opts.execHandle.controller.signal,
        );

        for (let retry = 0; retry <= 2; retry++) {
          const turn = await adapter.runTurn({
            projectPath: opts.worktreePath,
            prompt: currentPrompt,
            sessionId: currentSessionId,
            model: reviewerProfile.model || null,
            effort: reviewerProfile.effort,
            permissionMode: reviewerProfile.permissionMode,
            configDir: reviewerProfile.configDir,
            timeoutMs: reviewerProfile.timeoutMs,
            idleTimeoutMs: reviewerProfile.idleTimeoutMs,
            signal: opts.execHandle.controller.signal,
            logFilePath: absLogPath,
            onLogLine: emitAdapterLine,
          });
          capturedUsage = mergeTokenUsage(capturedUsage, turn.usage);
          currentSessionId = turn.sessionId ?? currentSessionId;
          if (currentSessionId) {
            this.db
              .update(runs)
              .set({ cliSessionId: currentSessionId })
              .where(eq(runs.id, reviewRunId))
              .run();
          }
          exitCode = turn.exitCode;
          stdout = turn.stdout;
          stderr = turn.stderr;
          aborted = Boolean(turn.aborted) || opts.execHandle.controller.signal.aborted;
          rateLimitFromStream = turn.rateLimitReason ?? rateLimitFromStream;

          if (aborted) break;
          if (rateLimitFromStream) break;
          if (exitCode !== null && exitCode !== 0) break;

          const checked = validateReviewTurnOutput({
            projectPath: opts.worktreePath,
            expectedTaskId: opts.task.externalId,
            verifyExitCode,
            turn,
          });
          if (checked.ok) {
            validatedContract = checked.data;
            break;
          }
          lastValidationError = checked.error;
          if (retry < 2) {
            emitDalangLine(`[dalang] ${lastValidationError}; requesting review repair...`);
            const jsonSchema = z.toJSONSchema(ReviewContractSchema);
            currentPrompt = [
              `Your previous review output failed validation:`,
              lastValidationError,
              ``,
              isReadOnly
                ? `Output ONLY a valid JSON object in your response matching:`
                : `Write a valid JSON file directly to "${opts.relReviewPath}" matching:`,
              JSON.stringify(jsonSchema, null, 2),
            ].join('\n');
          }
        }
      } catch (err) {
        aborted = opts.execHandle.controller.signal.aborted;
        if (!aborted) {
          thrownError = err instanceof Error ? err.message : String(err);
          emitDalangLine(`[dalang:error] ${thrownError}`);
        }
      } finally {
        lease?.release();
      }

      const reviewUsageFields = usageDbFields(
        reviewerProfile.provider,
        reviewerProfile.model || null,
        capturedUsage,
      );

      if (aborted) {
        const finishedAt = new Date().toISOString();
        this.db
          .update(runs)
          .set({ status: 'stopped', finishedAt, exitCode, failureReason: 'Stopped by user', ...reviewUsageFields })
          .where(eq(runs.id, reviewRunId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'stopped', updatedAt: finishedAt })
          .where(eq(tasks.id, opts.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId: reviewRunId,
          status: 'stopped',
          error: 'Stopped by user',
        });
        return {
          status: 'stopped',
          canFallback: false,
          verifyExitCode,
          verifyOutput,
        };
      }

      if (thrownError || rateLimitFromStream || (exitCode !== null && exitCode !== 0)) {
        const classified = rateLimitFromStream
          ? { eventType: 'rate_limit' as const, reason: rateLimitFromStream }
          : classifyProviderFailure(exitCode, stdout, stderr, thrownError);
        this.recordProviderEvent(
          reviewerProfile.provider,
          classified.eventType,
          classified.reason,
          reviewerProfile.configDir,
        );
        const finishedAt = new Date().toISOString();
        this.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt,
            exitCode,
            failureReason: classified.reason,
            ...reviewUsageFields,
          })
          .where(eq(runs.id, reviewRunId))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId: reviewRunId,
          status: 'failed',
          error: classified.reason,
        });
        return {
          status: 'failed',
          canFallback: true,
          verifyExitCode,
          verifyOutput,
          error: classified.reason,
        };
      }

      if (!validatedContract) {
        const finishedAt = new Date().toISOString();
        this.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt,
            exitCode,
            failureReason: lastValidationError,
            ...reviewUsageFields,
          })
          .where(eq(runs.id, reviewRunId))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId: reviewRunId,
          status: 'failed',
          error: lastValidationError,
        });
        return {
          status: 'failed',
          canFallback: false,
          verifyExitCode,
          verifyOutput,
          error: lastValidationError,
        };
      }

      // A scope violation fails the review whatever the reviewer said.
      if (opts.scopeWarnings.length > 0 && validatedContract.status === 'pass') {
        validatedContract = {
          ...validatedContract,
          status: 'fail',
          findings: [
            ...validatedContract.findings,
            ...opts.scopeWarnings.map((note) => ({ severity: 'major' as const, file: '', note })),
          ],
        };
      }
      const finalContract: ReviewContract = validatedContract;

      // Persist both canonical review.json and per-round archive safely inside the worktree.
      const serialized = JSON.stringify(finalContract, null, 2);
      const relRoundReviewPath = path.join(
        opts.relTaskDir,
        `review-round-${opts.round}.json`,
      );
      const absRoundReviewPath = path.join(opts.worktreePath, relRoundReviewPath);
      writeArtifactFile(opts.worktreePath, opts.absReviewPath, serialized, 'replace');
      writeArtifactFile(opts.worktreePath, absRoundReviewPath, serialized, 'replace');

      const checkpointAfter = await createGitCheckpoint(
        opts.worktreePath,
        `dalang: ${opts.task.externalId} review round ${opts.round} (${finalContract.status})`,
        opts.projectPath,
      );
      const finishedAt = new Date().toISOString();

      this.db
        .update(runs)
        .set({
          status: 'completed',
          finishedAt,
          exitCode,
          commitAfter: checkpointAfter.commitSha,
          resultPath: relRoundReviewPath,
          scopeWarningsJson: JSON.stringify(opts.scopeWarnings),
          ...reviewUsageFields,
        })
        .where(eq(runs.id, reviewRunId))
        .run();

      this.db
        .insert(reviews)
        .values({
          id: crypto.randomUUID(),
          projectId: opts.projectId,
          taskId: opts.task.id,
          runId: reviewRunId,
          round: opts.round,
          status: finalContract.status,
          humanDecision: 'pending',
          humanNote: null,
          reviewerProfileId: reviewerProfile.id,
          reviewerProvider: reviewerProfile.provider,
          reviewerModel: reviewerProfile.model || null,
          verifyCommand: opts.task.verify,
          verifyExitCode,
          verifyOutput,
          filePath: relRoundReviewPath,
          commitSha: checkpointAfter.commitSha,
          scopeWarningsJson: JSON.stringify(opts.scopeWarnings),
          createdAt: finishedAt,
          decidedAt: null,
        })
        .run();

      this.db
        .update(tasks)
        .set({ reviewRounds: opts.round, updatedAt: finishedAt })
        .where(eq(tasks.id, opts.task.id))
        .run();

      emitDalangLine(
        `[dalang] Review round ${opts.round} -> ${finalContract.status.toUpperCase()} (${finalContract.findings.length} findings)`,
      );
      this.events?.emitEvent({
        type: 'run.finished',
        projectId: opts.projectId,
        taskId: opts.task.id,
        runId: reviewRunId,
        status: 'completed',
      });
      this.events?.emitEvent({
        type: 'review.finished',
        projectId: opts.projectId,
        taskId: opts.task.id,
        round: opts.round,
        status: finalContract.status,
      });

      return {
        status: 'completed',
        canFallback: false,
        contract: finalContract,
        verifyExitCode,
        verifyOutput,
      };
    };

    const primaryOutcome = await runAttempt(opts.primaryReviewer, false);
    if (
      primaryOutcome.status === 'failed' &&
      primaryOutcome.canFallback &&
      opts.fallbackReviewer &&
      !opts.execHandle.controller.signal.aborted &&
      this.evaluateProviderUsability(
        opts.fallbackReviewer.provider,
        opts.fallbackReviewer.model || null,
        opts.sandboxReady,
        opts.fallbackReviewer.configDir,
      ).usable
    ) {
      const fbOutcome = await runAttempt(opts.fallbackReviewer, true, {
        exitCode: primaryOutcome.verifyExitCode,
        output: primaryOutcome.verifyOutput,
      });
      return {
        status: fbOutcome.status,
        contract: fbOutcome.contract,
        verifyOutput: fbOutcome.verifyOutput,
        error: fbOutcome.error,
      };
    }

    return {
      status: primaryOutcome.status,
      contract: primaryOutcome.contract,
      verifyOutput: primaryOutcome.verifyOutput,
      error: primaryOutcome.error,
    };
  }

  private validateResultFile(
    worktreePath: string,
    absResultPath: string,
    expectedTaskId: string,
  ): { ok: true; data: TaskResultContract } | { ok: false; error: string } {
    const rel = path.relative(worktreePath, absResultPath).split(path.sep).join('/');
    if (!fs.existsSync(absResultPath)) {
      return { ok: false, error: `Expected result file was not written at ${rel}` };
    }
    let raw: string;
    try {
      raw = readArtifactFile(worktreePath, absResultPath).trim();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: `${rel} is not valid JSON.` };
    }
    const validated = TaskResultContractSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: `Zod validation error: ${formatZodError(validated.error)}` };
    }
    if (validated.data.task_id !== expectedTaskId) {
      return {
        ok: false,
        error: `Result task_id "${validated.data.task_id}" does not match expected "${expectedTaskId}".`,
      };
    }
    return { ok: true, data: validated.data };
  }

  private buildTaskPrompt(
    task: TaskDTO,
    profile: AgentProfileDTO,
    relResultPath: string,
    rejectionNote?: string | null,
  ): string {
    const jsonSchema = z.toJSONSchema(TaskResultContractSchema);
    return [
      `You are executing task ${task.externalId}: "${task.title}" (milestone ${task.milestone}) for a project managed by DALANG.`,
      profile.rolePrompt ? `Role instructions: ${profile.rolePrompt}` : '',
      rejectionNote ? `Previous Guard rejection feedback (must be addressed):\n${rejectionNote}` : '',
      ``,
      `Read PROJECT.md first for project stack and conventions.`,
      ``,
      `Goal:`,
      task.goal,
      ``,
      `Allowed files (stay within these patterns; do not modify unrelated files):`,
      task.filesAllowed.length > 0 ? task.filesAllowed.map((f) => `- ${f}`).join('\n') : '- (project workspace)',
      ``,
      `Reference files:`,
      task.filesReference.length > 0 ? task.filesReference.map((f) => `- ${f}`).join('\n') : '- PROJECT.md',
      ``,
      `Acceptance criteria:`,
      task.acceptanceCriteria.map((c) => `- ${c}`).join('\n'),
      ``,
      `Verify command (must be run before finishing):`,
      task.verify,
      ``,
      `When done, write a JSON file directly to "${relResultPath}" matching this JSON Schema:`,
      JSON.stringify(jsonSchema, null, 2),
      ``,
      `Set "task_id" to "${task.externalId}" and "status" to "completed" (or "blocked"/"failed" if unable to finish).`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildResumePrompt(
    task: TaskDTO,
    relResultPath: string,
    rejectionNote?: string | null,
  ): string {
    return [
      `Resume work on task ${task.externalId}: "${task.title}".`,
      rejectionNote ? `Previous Guard rejection feedback:\n${rejectionNote}` : '',
      `Verify command to run before finishing: ${task.verify}`,
      `When finished, write the updated result JSON to "${relResultPath}" with task_id "${task.externalId}".`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async getRunLog(
    projectId: string,
    runId: string,
  ): Promise<{ runId: string; logPath: string; content: string }> {
    const project = this.getProjectRow(projectId);
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row || row.projectId !== projectId) {
      throw new Error(`Run not found: ${runId}`);
    }
    const content = await readArtifactWithGitFallback(project.path, row.logPath, row.commitAfter);
    return { runId: row.id, logPath: row.logPath, content: content ?? '' };
  }

  async getGuardState(
    projectId: string,
    explicitSessionId?: string,
  ): Promise<GuardStateDTO> {
    const project = this.getProjectRow(projectId);
    const sessionId = this.leadService.resolveSessionIdForRead(projectId, explicitSessionId);
    const plan = sessionId ? this.leadService.getPlan(projectId, sessionId) : null;
    const sandboxEngine = await this.registry.getSandboxEngine();
    const sandboxReady = sandboxEngine !== 'none';
    const detectedIntegrationCommand = detectIntegrationCommand(project.path);
    const [detectedRemote, ghPath] = await Promise.all([
      detectDefaultGitRemote(project.path).catch(() => null),
      this.registry.getRunner().which('gh').catch(() => null),
    ]);

    const sessionTaskIds = sessionId ? this.getTaskIdsForSession(sessionId) : [];
    const runRows =
      sessionTaskIds.length === 0
        ? []
        : this.db
            .select()
            .from(runs)
            .where(and(eq(runs.projectId, projectId), inArray(runs.taskId, sessionTaskIds)))
            .orderBy(desc(runs.startedAt), desc(runs.attempt))
            .all();
    const reviewRows =
      sessionTaskIds.length === 0
        ? []
        : this.db
            .select()
            .from(reviews)
            .where(and(eq(reviews.projectId, projectId), inArray(reviews.taskId, sessionTaskIds)))
            .orderBy(desc(reviews.createdAt), desc(reviews.round))
            .all();
    const integrationRows = this.db
      .select()
      .from(integrationRuns)
      .where(eq(integrationRuns.projectId, projectId))
      .orderBy(desc(integrationRuns.startedAt))
      .all();

    const taskById = new Map((plan?.tasks ?? []).map((t) => [t.id, t]));
    const profileById = new Map(this.profiles.listProfiles().map((p) => [p.id, p]));

    const runsByTask = new Map<string, TaskRunDTO[]>();
    for (const r of runRows) {
      const dto = await this.toRunDTO(
        project.path,
        r,
        taskById.get(r.taskId),
        profileById.get(r.profileId),
      );
      const list = runsByTask.get(r.taskId) ?? [];
      list.push(dto);
      runsByTask.set(r.taskId, list);
    }

    const reviewsByTask = new Map<string, TaskReviewDTO[]>();
    for (const rev of reviewRows) {
      const dto = await this.toReviewDTO(
        project.path,
        rev,
        taskById.get(rev.taskId),
        profileById.get(rev.reviewerProfileId),
      );
      if (!dto) continue;
      const list = reviewsByTask.get(rev.taskId) ?? [];
      list.push(dto);
      reviewsByTask.set(rev.taskId, list);
    }

    const guardTasks: GuardTaskEntryDTO[] = [];
    for (const task of plan?.tasks ?? []) {
      const taskReviews = reviewsByTask.get(task.id) ?? [];
      const inGuard =
        task.status === 'awaiting_merge' ||
        task.status === 'review_failed' ||
        task.status === 'reviewing' ||
        task.status === 'done' ||
        taskReviews.length > 0;
      if (!inGuard) continue;

      const taskRuns = runsByTask.get(task.id) ?? [];
      const latestRun = taskRuns[0] ?? null;
      const latestReview = taskReviews[0] ?? null;
      const diffAvailable = Boolean(
        task.branchName || task.mergeCommitSha || (latestRun?.commitBefore && latestRun?.commitAfter),
      );
      guardTasks.push({
        task,
        latestRun,
        reviews: taskReviews,
        latestReview,
        diffAvailable,
        canApproveMerge: task.status === 'awaiting_merge' || task.status === 'review_failed',
        canReject: task.status === 'awaiting_merge' || task.status === 'review_failed',
      });
    }

    return {
      projectId,
      sessionId,
      mainBranch: project.mainBranch,
      integrationCommand: project.integrationCommand ?? null,
      detectedIntegrationCommand,
      pushAfterMerge: Boolean(project.pushAfterMerge),
      createPrAfterMerge: Boolean(project.createPrAfterMerge),
      gitRemote: project.gitRemote ?? detectedRemote ?? null,
      ghAvailable: Boolean(ghPath),
      sandboxReady,
      sandboxEngine,
      platform: process.platform,
      tasks: guardTasks,
      integrationRuns: integrationRows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        taskId: row.taskId ?? null,
        taskExternalId: row.taskId ? (taskById.get(row.taskId)?.externalId ?? null) : null,
        mergeCommitSha: row.mergeCommitSha ?? null,
        command: row.command,
        status: row.status as 'passed' | 'failed' | 'skipped',
        exitCode: row.exitCode ?? null,
        output: row.output,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      })),
    };
  }

  async getTaskDiffForTask(
    projectId: string,
    taskId: string,
    explicitSessionId?: string,
  ): Promise<TaskDiffDTO> {
    const project = this.getProjectRow(projectId);
    const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
    if (!plan) throw new Error('No plan exists for this project.');
    const task = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const taskRuns = this.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(desc(runs.startedAt), desc(runs.attempt))
      .all();
    const latestRun = taskRuns[0];
    const earliestCoderRun = [...taskRuns].reverse().find((r) => r.status !== 'rolled_back');

    if (task.mergeCommitSha) {
      return getTaskDiff(
        project.path,
        task.id,
        task.externalId,
        task.branchName,
        `${task.mergeCommitSha}^1`,
        task.mergeCommitSha,
      );
    }

    if (task.branchName && (await branchExists(project.path, task.branchName))) {
      const baseRef = earliestCoderRun?.commitBefore ?? project.mainBranch;
      return getTaskDiff(
        project.path,
        task.id,
        task.externalId,
        task.branchName,
        baseRef,
        task.branchName,
      );
    }

    if (earliestCoderRun?.commitBefore && latestRun?.commitAfter) {
      return getTaskDiff(
        project.path,
        task.id,
        task.externalId,
        task.branchName,
        earliestCoderRun.commitBefore,
        latestRun.commitAfter,
      );
    }

    return {
      taskId: task.id,
      externalId: task.externalId,
      branchName: task.branchName,
      baseCommitSha: null,
      headCommitSha: null,
      files: [],
      rawDiff: '',
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    };
  }

  async approveMergeTask(
    projectId: string,
    taskId: string,
    input: Partial<ApproveMergeInput> = {},
    explicitSessionId?: string,
  ): Promise<{
    task: TaskDTO;
    mergeCommitSha: string;
    integrationRun: IntegrationRunDTO | null;
    pushPrResult?: PushPrResultDTO | null;
  }> {
    const project = this.getProjectRow(projectId);
    const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('No plan exists for this project.');
    const task = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (this.activeTasks.has(task.id) || task.status === 'running' || task.status === 'reviewing') {
      throw new Error(`Wait for ${task.externalId} to finish running before merging.`);
    }
    if (task.status === 'done') {
      throw new Error(`Task ${task.externalId} has already been merged.`);
    }
    if (task.status !== 'awaiting_merge' && !(task.status === 'review_failed' && input.allowFailedReview)) {
      if (task.status === 'review_failed') {
        throw new Error(
          `Task ${task.externalId} failed review. Confirm override (allowFailedReview) or reject it back to the coder.`,
        );
      }
      throw new Error(`Task ${task.externalId} is "${task.status}" and is not ready for merge.`);
    }

    const branchName = task.branchName ?? `dalang/${task.externalId}`;
    const worktreePath = getTaskWorktreeDir(this.worktreesRoot, projectId, task.externalId);

    const { mergeCommitSha } = await this.withProjectGitLock(projectId, async () => {
      const merged = await mergeTaskBranchToMain(
        project.path,
        project.mainBranch,
        branchName,
        `dalang: merge ${task.externalId} (${task.title})`,
      );
      await removeTaskWorktree(project.path, worktreePath).catch(() => undefined);
      return merged;
    });

    const now = new Date().toISOString();
    this.db
      .update(reviews)
      .set({ humanDecision: 'approved', decidedAt: now })
      .where(and(eq(reviews.taskId, task.id), eq(reviews.humanDecision, 'pending')))
      .run();

    this.db
      .update(tasks)
      .set({
        status: 'done',
        mergeCommitSha,
        rejectionNote: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))
      .run();

    const stillActive = [...this.activeTasks.values()].some((a) => a.sessionId === sid);
    this.leadService.reconcileSessionWorkState(sid, stillActive);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });

    let integrationRun: IntegrationRunDTO | null = null;
    if (input.runIntegration !== false) {
      integrationRun = await this.runIntegrationTests(projectId, {
        taskId: task.id,
        mergeCommitSha,
        fromMerge: true,
        allowUnconfined: input.allowUnconfined,
      });
    }

    const shouldCreatePr = input.createPrAfterMerge ?? Boolean(project.createPrAfterMerge);
    const shouldPush = input.pushAfterMerge ?? Boolean(project.pushAfterMerge);
    let pushPrResult: PushPrResultDTO | null = null;
    if (shouldCreatePr || shouldPush) {
      try {
        pushPrResult = await this.pushTaskBranchAndPr(
          projectId,
          task.id,
          {
            remote: project.gitRemote ?? undefined,
            createPr: shouldCreatePr,
          },
          sid,
        );
      } catch (err) {
        pushPrResult = {
          pushed: false,
          remote: project.gitRemote ?? 'origin',
          branch: shouldCreatePr ? branchName : project.mainBranch,
          prUrl: null,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const updatedTask = this.leadService.getPlan(projectId, sid)!.tasks.find((t) => t.id === task.id)!;
    return { task: updatedTask, mergeCommitSha, integrationRun, pushPrResult };
  }

  private buildPullRequestBody(task: TaskDTO, latestReview: TaskReviewDTO | null): string {
    const lines: string[] = [
      `## Task ${task.externalId}: ${task.title}`,
      '',
      `### Goal`,
      task.goal,
      '',
      `### Acceptance Criteria`,
      ...task.acceptanceCriteria.map((c) => `- ${c}`),
      '',
    ];
    if (latestReview) {
      lines.push(
        `### Automated Review (Round ${latestReview.round})`,
        `- Verdict: **${latestReview.status.toUpperCase()}**`,
        `- Reviewer: ${latestReview.reviewerProfileName} (${latestReview.reviewerProvider}${latestReview.reviewerModel ? ` / ${latestReview.reviewerModel}` : ''})`,
        `- Verify (\`${latestReview.verifyCommand}\`): exit ${latestReview.verifyExitCode}`,
      );
      if (latestReview.contract.summary) {
        lines.push('', latestReview.contract.summary);
      }
      if (latestReview.contract.findings.length > 0) {
        lines.push('', '#### Findings');
        for (const f of latestReview.contract.findings) {
          lines.push(`- [${f.severity}] ${f.file ? `\`${f.file}\`: ` : ''}${f.note}`);
        }
      }
    }
    if (task.mergeCommitSha) {
      lines.push('', `Merged locally on \`${task.mergeCommitSha.slice(0, 8)}\`.`);
    }
    return lines.join('\n');
  }

  /**
   * Push a merged task's branch (or main branch when createPr=false) and optionally open a PR via `gh`.
   */
  async pushTaskBranchAndPr(
    projectId: string,
    taskId: string,
    input: Partial<PushPrInput> = {},
    explicitSessionId?: string,
  ): Promise<PushPrResultDTO> {
    const project = this.getProjectRow(projectId);
    const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
    if (!plan) throw new Error('No plan exists for this project.');
    const task = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'done' && task.status !== 'awaiting_merge') {
      throw new Error(`Task ${task.externalId} must be awaiting merge or merged before pushing.`);
    }

    const remote =
      input.remote?.trim() ||
      project.gitRemote?.trim() ||
      (await detectDefaultGitRemote(project.path));
    if (!remote) {
      throw new Error(
        'No git remote is configured for this repository. Add a remote (e.g. `git remote add origin <url>`) first.',
      );
    }

    const createPr = input.createPr !== false;
    const taskBranch = task.branchName ?? `dalang/${task.externalId}`;
    let pushedBranch = project.mainBranch;
    let prUrl: string | null = task.prUrl ?? null;

    await this.withProjectGitLock(projectId, async () => {
      if (createPr) {
        // Push the task branch tip (parent 2 of merge commit if already merged, else the live branch).
        const hasLocalBranch = await branchExists(project.path, taskBranch);
        const refspec = hasLocalBranch
          ? taskBranch
          : task.mergeCommitSha
            ? `${task.mergeCommitSha}^2:refs/heads/${taskBranch}`
            : taskBranch;
        await pushRefToRemote(project.path, remote, refspec);
        pushedBranch = taskBranch;
      } else {
        await pushRefToRemote(project.path, remote, project.mainBranch);
        pushedBranch = project.mainBranch;
      }
    });

    if (createPr) {
      const reviewRows = this.db
        .select()
        .from(reviews)
        .where(eq(reviews.taskId, task.id))
        .orderBy(desc(reviews.round))
        .all();
      const profileById = new Map(this.profiles.listProfiles().map((p) => [p.id, p]));
      const latestReview = reviewRows[0]
        ? await this.toReviewDTO(
            project.path,
            reviewRows[0],
            task,
            profileById.get(reviewRows[0].reviewerProfileId),
          )
        : null;
      const body = this.buildPullRequestBody(task, latestReview);
      const pr = await createGitHubPullRequest(this.registry.getRunner(), project.path, {
        baseBranch: project.mainBranch,
        headBranch: taskBranch,
        title: `${task.externalId}: ${task.title}`,
        body,
      });
      prUrl = pr.prUrl || prUrl;
    }

    const pushedAt = new Date().toISOString();
    this.db
      .update(tasks)
      .set({
        ...(prUrl ? { prUrl } : {}),
        pushedAt,
        updatedAt: pushedAt,
      })
      .where(eq(tasks.id, task.id))
      .run();
    this.events?.emitEvent({ type: 'plan.updated', projectId });

    return {
      pushed: true,
      remote,
      branch: pushedBranch,
      prUrl,
      message: prUrl
        ? `Pushed ${pushedBranch} to ${remote} and opened PR: ${prUrl}`
        : `Pushed ${pushedBranch} to ${remote}.`,
    };
  }

  async rejectTask(
    projectId: string,
    taskId: string,
    input: Partial<RejectTaskInput> = {},
    explicitSessionId?: string,
  ): Promise<TaskDTO> {
    const project = this.getProjectRow(projectId);
    const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('No plan exists for this project.');
    const task = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (this.activeTasks.has(task.id) || task.status === 'running' || task.status === 'reviewing') {
      throw new Error(`Wait for ${task.externalId} to finish running before rejecting it.`);
    }
    if (task.status !== 'awaiting_merge' && task.status !== 'review_failed') {
      throw new Error(`Task ${task.externalId} is "${task.status}" and cannot be rejected in Guard.`);
    }

    // Preserve task logs on disk before deleting the unmerged branch/worktree.
    const taskRuns = this.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .all();
    for (const r of taskRuns) {
      const content = await readArtifactWithGitFallback(project.path, r.logPath, r.commitAfter);
      if (content !== null) {
        const abs = path.join(project.path, r.logPath);
        if (!fs.existsSync(abs)) {
          writeArtifactFile(project.path, abs, content, 'refuse');
        }
      }
    }

    const branchName = task.branchName ?? `dalang/${task.externalId}`;
    const worktreePath = getTaskWorktreeDir(this.worktreesRoot, projectId, task.externalId);
    await this.withProjectGitLock(projectId, async () => {
      await removeTaskWorktree(project.path, worktreePath).catch(() => undefined);
      await deleteTaskBranch(project.path, project.mainBranch, branchName);
    });

    const now = new Date().toISOString();
    const note = input.note?.trim() || 'Rejected in Guard';
    this.db
      .update(reviews)
      .set({
        humanDecision: 'rejected',
        humanNote: note,
        decidedAt: now,
      })
      .where(and(eq(reviews.taskId, task.id), eq(reviews.humanDecision, 'pending')))
      .run();

    this.db
      .update(tasks)
      .set({
        status: input.requeue ? 'approved' : 'failed',
        branchName: null,
        rejectionNote: note,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))
      .run();

    const stillActive = [...this.activeTasks.values()].some((a) => a.sessionId === sid);
    this.leadService.reconcileSessionWorkState(sid, stillActive);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });
    return this.leadService.getPlan(projectId, sid)!.tasks.find((t) => t.id === task.id)!;
  }

  /**
   * Discard all unfinished/unmerged work in a session: stops active runs, removes unmerged
   * worktrees and branches, never touches merged code, and returns the session to `idle`.
   */
  async discardSessionWork(
    projectId: string,
    sessionId: string,
  ): Promise<{ session: SessionSummaryDTO; discardedTasks: number }> {
    const project = this.getProjectRow(projectId);
    this.leadService.getSessionRow(projectId, sessionId);

    await this.stopExecution(projectId, undefined, sessionId);

    const sessionPlans = this.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .all();

    let discardedTasks = 0;
    if (sessionPlans.length > 0) {
      const allTasks = this.db
        .select()
        .from(tasks)
        .where(inArray(tasks.planId, sessionPlans.map((p) => p.id)))
        .all();

      const unfinished = allTasks.filter(
        (t) =>
          t.status !== 'done' &&
          (Boolean(t.branchName) ||
            t.status === 'running' ||
            t.status === 'reviewing' ||
            t.status === 'awaiting_merge' ||
            t.status === 'review_failed' ||
            t.status === 'stopped'),
      );

      const now = new Date().toISOString();
      for (const task of unfinished) {
        const taskRuns = this.db.select().from(runs).where(eq(runs.taskId, task.id)).all();
        for (const r of taskRuns) {
          const content = await readArtifactWithGitFallback(project.path, r.logPath, r.commitAfter);
          if (content !== null) {
            const abs = path.join(project.path, r.logPath);
            if (!fs.existsSync(abs)) {
              writeArtifactFile(project.path, abs, content, 'refuse');
            }
          }
        }

        const branchName = task.branchName ?? `dalang/${task.externalId}`;
        const worktreePath = getTaskWorktreeDir(this.worktreesRoot, projectId, task.externalId);
        await this.withProjectGitLock(projectId, async () => {
          await removeTaskWorktree(project.path, worktreePath).catch(() => undefined);
          if (await branchExists(project.path, branchName)) {
            await deleteTaskBranch(project.path, project.mainBranch, branchName).catch(() => undefined);
          }
        });

        this.db
          .update(reviews)
          .set({
            humanDecision: 'rejected',
            humanNote: 'Discarded by user',
            decidedAt: now,
          })
          .where(and(eq(reviews.taskId, task.id), eq(reviews.humanDecision, 'pending')))
          .run();

        this.db
          .update(tasks)
          .set({
            status: 'failed',
            branchName: null,
            rejectionNote: 'Discarded by user',
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id))
          .run();

        discardedTasks += 1;
      }
    }

    this.leadService.reconcileSessionWorkState(sessionId, false);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId });
    return {
      session: this.leadService.getSession(projectId, sessionId),
      discardedTasks,
    };
  }

  async runIntegrationTests(
    projectId: string,
    opts: {
      command?: string;
      taskId?: string;
      mergeCommitSha?: string;
      allowUnconfined?: boolean;
      fromMerge?: boolean;
    } = {},
  ): Promise<IntegrationRunDTO> {
    const project = this.getProjectRow(projectId);

    const command =
      opts.command?.trim() ||
      project.integrationCommand?.trim() ||
      detectIntegrationCommand(project.path);

    const startedAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const plan = this.leadService.getPlan(projectId);
    const taskExtId = opts.taskId
      ? (plan?.tasks.find((t) => t.id === opts.taskId)?.externalId ?? null)
      : null;

    if (!command) {
      const finishedAt = new Date().toISOString();
      const row = {
        id,
        projectId,
        taskId: opts.taskId ?? null,
        mergeCommitSha: opts.mergeCommitSha ?? null,
        command: '(none configured)',
        status: 'skipped' as const,
        exitCode: null,
        output: 'No project test command detected or configured. Set an integration command in Guard to enable automated post-merge runs.',
        startedAt,
        finishedAt,
      };
      this.db.insert(integrationRuns).values(row).run();
      this.events?.emitEvent({
        type: 'integration.finished',
        projectId,
        taskId: opts.taskId ?? null,
        status: 'skipped',
      });
      return { ...row, taskExternalId: taskExtId };
    }

    const sandboxReady = await this.registry.isSandboxReady();
    if (!sandboxReady && !opts.allowUnconfined) {
      if (opts.fromMerge) {
        const finishedAt = new Date().toISOString();
        const row = {
          id,
          projectId,
          taskId: opts.taskId ?? null,
          mergeCommitSha: opts.mergeCommitSha ?? null,
          command,
          status: 'skipped' as const,
          exitCode: null,
          output: `Bubblewrap sandbox unavailable on ${process.platform}; confirm unconfined execution in Guard to run "${command}".`,
          startedAt,
          finishedAt,
        };
        this.db.insert(integrationRuns).values(row).run();
        this.events?.emitEvent({
          type: 'integration.finished',
          projectId,
          taskId: opts.taskId ?? null,
          status: 'skipped',
        });
        return { ...row, taskExternalId: taskExtId };
      }
      throw new Error(
        `Bubblewrap sandbox is unavailable on ${process.platform}. Confirm unconfined execution to run the integration test suite.`,
      );
    }

    const res = await this.withProjectGitLock(projectId, async () => {
      return this.registry.runShellCommand(project.path, command, {
        timeoutMs: 300_000,
        idleTimeoutMs: 120_000,
      });
    });

    const finishedAt = new Date().toISOString();
    const timedOut = res.timedOut || res.idleTimedOut;
    const exitCode = timedOut ? 124 : (res.exitCode ?? 1);
    const status: 'passed' | 'failed' = exitCode === 0 ? 'passed' : 'failed';
    const combinedOutput = [res.stdout, res.stderr].filter(Boolean).join('\n');
    const output = tailOutput(
      timedOut ? `${combinedOutput}\n[dalang] Integration suite timed out.` : combinedOutput,
      12_000,
    );

    this.db
      .insert(integrationRuns)
      .values({
        id,
        projectId,
        taskId: opts.taskId ?? null,
        mergeCommitSha: opts.mergeCommitSha ?? null,
        command,
        status,
        exitCode,
        output,
        startedAt,
        finishedAt,
      })
      .run();

    this.events?.emitEvent({
      type: 'integration.finished',
      projectId,
      taskId: opts.taskId ?? null,
      status,
    });

    return {
      id,
      projectId,
      taskId: opts.taskId ?? null,
      taskExternalId: taskExtId,
      mergeCommitSha: opts.mergeCommitSha ?? null,
      command,
      status,
      exitCode,
      output,
      startedAt,
      finishedAt,
    };
  }

  async rollbackRun(projectId: string, runId: string): Promise<TaskRunDTO> {
    const project = this.getProjectRow(projectId);
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row || row.projectId !== projectId) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (row.status === 'running') {
      throw new Error('Cannot roll back a run that is still running.');
    }
    if (row.status === 'rolled_back') {
      throw new Error('This run has already been rolled back.');
    }
    if (!row.commitBefore) {
      throw new Error('This run does not have a pre-run checkpoint commit.');
    }
    const commitBefore = row.commitBefore;

    const plan = this.leadService.getPlan(projectId);
    const targetTask = plan?.tasks.find((t) => t.id === row.taskId);

    const taskBranch = targetTask?.branchName ?? row.branchName;
    const isUnmergedBranchRun =
      Boolean(taskBranch) &&
      !targetTask?.mergeCommitSha &&
      (await branchExists(project.path, taskBranch!));

    if (isUnmergedBranchRun) {
      if (this.activeTasks.has(row.taskId)) {
        throw new Error('Stop the active run on this task before rolling it back.');
      }
    } else if (this.hasActiveTasksForProject(projectId)) {
      throw new Error('Stop active runs on this project before rolling back a merged checkpoint.');
    }

    const affectedTaskIds = new Set<string>([row.taskId]);
    const rolledBackRunIds: string[] = [];

    await this.withProjectGitLock(projectId, async () => {
      // `git reset --hard` is destructive: only run it when the repo still ends where DALANG left it.
      const state = await getRepoState(project.path);
      if (state.dirtyFiles.length > 0) {
        throw new Error(
          `Uncommitted changes would be lost (${state.dirtyFiles.slice(0, 3).join(', ')}). Commit or stash them first.`,
        );
      }

      if (isUnmergedBranchRun && taskBranch) {
        const mainHead = state.head;
        const lastMergedOrMain = this.db
          .select()
          .from(runs)
          .where(and(eq(runs.projectId, projectId), ne(runs.status, 'rolled_back'), ne(runs.status, 'running')))
          .orderBy(desc(runs.startedAt), desc(runs.attempt))
          .all()
          .find((r) => r.commitBefore);
        const knownMainCommits = new Set<string>(
          [
            ...this.db
              .select()
              .from(runs)
              .where(and(eq(runs.projectId, projectId), eq(runs.kind, 'execute')))
              .all()
              .map((r) => r.commitBefore),
            lastMergedOrMain?.commitBefore,
            ...(plan?.tasks.map((t) => t.mergeCommitSha) ?? []),
          ].filter((c): c is string => Boolean(c)),
        );
        if (mainHead && knownMainCommits.size > 0 && !knownMainCommits.has(mainHead)) {
          throw new Error(
            'The repository has commits that DALANG did not create after the last run. Roll back manually with git.',
          );
        }

        const worktreePath = getTaskWorktreeDir(
          this.worktreesRoot,
          projectId,
          targetTask?.externalId ?? row.taskId,
        );
        await removeTaskWorktree(project.path, worktreePath).catch(() => undefined);
        await deleteTaskBranch(project.path, project.mainBranch, taskBranch);
      } else {
        const lastKnown = this.db
          .select()
          .from(runs)
          .where(and(eq(runs.projectId, projectId), ne(runs.status, 'rolled_back'), ne(runs.status, 'running')))
          .orderBy(desc(runs.startedAt), desc(runs.attempt))
          .all()
          .find((r) => r.commitAfter);
        const knownTips = new Set<string>(
          [
            lastKnown?.commitAfter,
            ...(plan?.tasks.map((t) => t.mergeCommitSha) ?? []),
          ].filter((c): c is string => Boolean(c)),
        );
        if (knownTips.size > 0 && state.head && !knownTips.has(state.head)) {
          throw new Error(
            'The repository has commits that DALANG did not create after the last run. Roll back manually with git.',
          );
        }

        // Identify any other merged tasks whose merge commit will be rewound by resetting to `commitBefore`.
        for (const t of plan?.tasks ?? []) {
          if (t.mergeCommitSha) {
            const kept = await isAncestorCommit(project.path, t.mergeCommitSha, commitBefore);
            if (!kept) affectedTaskIds.add(t.id);
          }
        }

        await rollbackGitToCheckpoint(project.path, commitBefore);
      }
    });

    const now = new Date().toISOString();
    const projectRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(
            isUnmergedBranchRun ? eq(runs.taskId, row.taskId) : gte(runs.startedAt, row.startedAt),
            eq(runs.id, row.id),
          ),
        ),
      )
      .all();

    for (const r of projectRuns) {
      if (r.status === 'rolled_back') continue;
      if (isUnmergedBranchRun) {
        if (r.taskId === row.taskId) rolledBackRunIds.push(r.id);
      } else if (
        affectedTaskIds.has(r.taskId) ||
        r.startedAt > row.startedAt ||
        (r.startedAt === row.startedAt && r.attempt >= row.attempt) ||
        r.id === row.id
      ) {
        rolledBackRunIds.push(r.id);
        affectedTaskIds.add(r.taskId);
      }
    }

    // Include runs belonging to rewound merged tasks even if they started before `row.startedAt` (parallel execution).
    if (!isUnmergedBranchRun && affectedTaskIds.size > 0) {
      const rewoundTaskRuns = this.db
        .select()
        .from(runs)
        .where(inArray(runs.taskId, [...affectedTaskIds]))
        .all();
      for (const r of rewoundTaskRuns) {
        if (r.status !== 'rolled_back' && !rolledBackRunIds.includes(r.id)) {
          rolledBackRunIds.push(r.id);
        }
      }
    }

    if (rolledBackRunIds.length > 0) {
      this.db
        .update(runs)
        .set({ status: 'rolled_back' })
        .where(inArray(runs.id, rolledBackRunIds))
        .run();
    }

    if (affectedTaskIds.size > 0) {
      this.db
        .update(tasks)
        .set({
          status: 'approved',
          branchName: null,
          mergeCommitSha: null,
          reviewRounds: 0,
          rejectionNote: null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(tasks.id, [...affectedTaskIds]),
            inArray(tasks.status, [
              'done',
              'failed',
              'stopped',
              'awaiting_merge',
              'review_failed',
            ]),
          ),
        )
        .run();
    }

    const sid = this.leadService.resolveSessionIdForTask(projectId, row.taskId);
    if (sid) {
      const stillActive = [...this.activeTasks.values()].some((a) => a.sessionId === sid);
      this.leadService.reconcileSessionWorkState(sid, stillActive);
    }

    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid ?? undefined });

    const updatedRow = this.db.select().from(runs).where(eq(runs.id, row.id)).get()!;
    const latestPlan = sid ? this.leadService.getPlan(projectId, sid) : this.leadService.getPlan(projectId);
    const task = latestPlan?.tasks.find((t) => t.id === row.taskId);
    const profile = this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, row.profileId))
      .get();

    return this.toRunDTO(
      project.path,
      updatedRow,
      task,
      profile ? this.profiles.getProfile(profile.id) : undefined,
    );
  }

  private async toRunDTO(
    projectPath: string,
    row: typeof runs.$inferSelect,
    task?: TaskDTO,
    profile?: AgentProfileDTO,
  ): Promise<TaskRunDTO> {
    let result: TaskResultContract | null = null;
    if (row.resultPath && row.kind !== 'review') {
      let raw = await readArtifactWithGitFallback(projectPath, row.resultPath, row.commitAfter);
      if (!raw && row.worktreePath && fs.existsSync(row.worktreePath)) {
        raw = await readArtifactWithGitFallback(row.worktreePath, row.resultPath, null);
      }
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          const checked = TaskResultContractSchema.safeParse(parsed);
          if (checked.success) result = checked.data;
        } catch {
          result = null;
        }
      }
    }

    let scopeWarnings: string[] = [];
    try {
      scopeWarnings = JSON.parse(row.scopeWarningsJson) as string[];
    } catch {
      scopeWarnings = [];
    }

    const durationMs =
      row.finishedAt && row.startedAt
        ? Math.max(0, new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime())
        : null;

    return {
      id: row.id,
      projectId: row.projectId,
      taskId: row.taskId,
      taskExternalId: task?.externalId ?? row.taskId,
      taskTitle: task?.title ?? 'Task',
      profileId: row.profileId,
      profileName: profile?.name ?? row.profileId,
      provider: row.provider as ProviderId,
      accountKey: row.accountKey ?? row.provider,
      model: row.model,
      kind: (row.kind as RunKind) ?? 'execute',
      branchName: row.branchName ?? null,
      worktreePath: row.worktreePath ?? null,
      status: row.status as RunStatus,
      cliSessionId: row.cliSessionId,
      attempt: row.attempt,
      usedFallback: Boolean(row.usedFallback),
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs,
      exitCode: row.exitCode,
      failureReason: row.failureReason,
      commitBefore: row.commitBefore,
      commitAfter: row.commitAfter,
      checkpointBeforeRef: row.checkpointBeforeRef ?? null,
      checkpointAfterRef: row.checkpointAfterRef ?? null,
      logPath: row.logPath,
      resultPath: row.resultPath,
      result,
      scopeWarnings,
      inputTokens: row.inputTokens ?? null,
      outputTokens: row.outputTokens ?? null,
      cacheReadTokens: row.cacheReadTokens ?? null,
      cacheWriteTokens: row.cacheWriteTokens ?? null,
      estimatedCostUsd: row.estimatedCostUsd ?? null,
      costSource: (row.costSource as 'cli' | 'estimated' | null) ?? null,
    };
  }

  private async toReviewDTO(
    projectPath: string,
    row: typeof reviews.$inferSelect,
    task?: TaskDTO,
    profile?: AgentProfileDTO,
  ): Promise<TaskReviewDTO | null> {
    let contract: ReviewContract = {
      task_id: task?.externalId ?? row.taskId,
      status: row.status as 'pass' | 'fail',
      verify_exit_code: row.verifyExitCode,
      findings: [],
    };
    const raw = await readArtifactWithGitFallback(projectPath, row.filePath, row.commitSha);
    if (raw) {
      try {
        const parsed = ReviewContractSchema.safeParse(JSON.parse(raw));
        if (parsed.success) contract = parsed.data;
      } catch {
        // Use summary fields stored in SQLite if artifact file cannot be parsed.
      }
    }

    let scopeWarnings: string[] = [];
    try {
      scopeWarnings = JSON.parse(row.scopeWarningsJson) as string[];
    } catch {
      scopeWarnings = [];
    }

    return {
      id: row.id,
      projectId: row.projectId,
      taskId: row.taskId,
      taskExternalId: task?.externalId ?? row.taskId,
      taskTitle: task?.title ?? 'Task',
      runId: row.runId,
      round: row.round,
      status: row.status as 'pass' | 'fail',
      humanDecision: row.humanDecision as 'pending' | 'approved' | 'rejected',
      humanNote: row.humanNote ?? null,
      reviewerProfileId: row.reviewerProfileId,
      reviewerProfileName: profile?.name ?? row.reviewerProfileId,
      reviewerProvider: row.reviewerProvider as ProviderId,
      reviewerModel: row.reviewerModel ?? null,
      verifyCommand: row.verifyCommand,
      verifyExitCode: row.verifyExitCode,
      verifyOutput: row.verifyOutput,
      filePath: row.filePath,
      commitSha: row.commitSha ?? null,
      contract,
      scopeWarnings,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt ?? null,
    };
  }
}
