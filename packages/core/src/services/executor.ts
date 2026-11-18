import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, gte, inArray, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  TaskResultContractSchema,
  type AgentProfileDTO,
  type ExecutionStateDTO,
  type PlanDTO,
  type ProviderId,
  type RunStatus,
  type StartExecutionInput,
  type TaskDispatchPreviewDTO,
  type TaskDTO,
  type TaskResultContract,
  type TaskRunDTO,
  type TaskStatus,
} from '@dalang/shared';
import { createTurnLogger } from '../adapters/logger.js';
import type { ProviderRegistry } from '../adapters/registry.js';
import type { DalangDb } from '../db/client.js';
import { agentProfiles, projects, providerEvents, runs, tasks } from '../db/schema.js';
import { getProjectLogsDir, getTaskArtifactDir } from '../paths.js';
import { ensureProjectDir, readArtifactFile, removeArtifactFile } from '../safe-fs.js';
import { formatZodError } from './contract.js';
import type { DalangEventBus } from './events.js';
import {
  createGitCheckpoint,
  getChangedFilesSinceCommit,
  getRepoState,
  rollbackGitToCheckpoint,
} from './git.js';
import type { LeadService } from './lead.js';
import { ProfileService } from './profiles.js';

interface ActiveProjectExecution {
  runId: string;
  taskId: string;
  queueMode: boolean;
  queueCancelled: boolean;
  controller: AbortController;
  promise: Promise<void>;
}

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
 * Every run must write its `result.json`, so a `read-only` profile (the seeded reviewer) cannot run a
 * task as-is. The review step that can honor read-only arrives with the v0.3 reviewer.
 */
function writePermission(profile: AgentProfileDTO): 'workspace-write' | 'accept-edits' {
  return profile.permissionMode === 'read-only' ? 'workspace-write' : profile.permissionMode;
}

export class ExecutionService {
  private readonly profiles: ProfileService;
  private readonly activeProjects = new Map<string, ActiveProjectExecution>();
  private readonly activeProviderCounts = new Map<ProviderId, number>();

  constructor(
    private readonly db: DalangDb,
    private readonly registry: ProviderRegistry,
    private readonly leadService: LeadService,
    private readonly events?: DalangEventBus,
  ) {
    this.profiles = new ProfileService(db);
    this.reconcileInterruptedRuns();
  }

  /**
   * Reconcile any runs/tasks left in `running` state from an unexpected process exit/restart.
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
      .where(eq(tasks.status, 'running'))
      .run();
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

  private incrementProviderCount(provider: ProviderId): void {
    this.activeProviderCounts.set(provider, (this.activeProviderCounts.get(provider) ?? 0) + 1);
  }

  private decrementProviderCount(provider: ProviderId): void {
    const current = this.activeProviderCounts.get(provider) ?? 0;
    if (current <= 1) this.activeProviderCounts.delete(provider);
    else this.activeProviderCounts.set(provider, current - 1);
  }

  private getProviderActiveCount(provider: ProviderId): number {
    return this.activeProviderCounts.get(provider) ?? 0;
  }

  assignTaskProfile(projectId: string, taskId: string, profileOverride: string | null): TaskDTO {
    const plan = this.leadService.getPlan(projectId);
    if (!plan) throw new Error('No plan exists for this project.');
    const target = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!target) throw new Error(`Task not found: ${taskId}`);
    if (target.status === 'running') {
      throw new Error(`Cannot reassign ${target.externalId} while it is running.`);
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

    this.events?.emitEvent({ type: 'plan.updated', projectId });
    return this.leadService.getPlan(projectId)!.tasks.find((t) => t.id === target.id)!;
  }

  async getExecutionState(projectId: string): Promise<ExecutionStateDTO> {
    const project = this.getProjectRow(projectId);
    const plan = this.leadService.getPlan(projectId);
    const sandboxReady = await this.registry.isSandboxReady();

    const dispatchPreviews = plan ? this.buildDispatchPreviews(plan, sandboxReady) : [];
    const runRows = this.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .orderBy(desc(runs.startedAt), desc(runs.attempt))
      .all();

    const taskById = new Map((plan?.tasks ?? []).map((t) => [t.id, t]));
    const profileById = new Map(this.profiles.listProfiles().map((p) => [p.id, p]));

    const runDtos = runRows.map((row) =>
      this.toRunDTO(project.path, row, taskById.get(row.taskId), profileById.get(row.profileId)),
    );

    const activeExec = this.activeProjects.get(projectId);
    const activeRun = activeExec
      ? (runDtos.find((r) => r.id === activeExec.runId) ??
        runDtos.find((r) => r.status === 'running') ??
        null)
      : (runDtos.find((r) => r.status === 'running') ?? null);

    return {
      projectId,
      planStatus: plan ? plan.status : 'none',
      activeRun,
      queueRunning: Boolean(activeExec?.queueMode && !activeExec.queueCancelled),
      sandboxReady,
      platform: process.platform,
      dispatchPreviews,
      runs: runDtos,
    };
  }

  /**
   * Routing plus the keyring opt-in: a task routed to Antigravity runs on its backup profile while that
   * opt-in is off, and is blocked with a reason when there is no usable backup.
   */
  private routeTask(
    task: Pick<TaskDTO, 'role' | 'complexity' | 'profileOverride'>,
    sandboxReady: boolean,
  ): ReturnType<ProfileService['resolveProfileForTask']> & { note: string | null; blocked: string | null } {
    const routing = this.profiles.resolveProfileForTask({
      role: task.role,
      complexity: task.complexity,
      profileOverride: task.profileOverride,
    });
    const reason = this.registry.providerBlockedReason(routing.primary.provider, sandboxReady);
    if (!reason) return { ...routing, note: null, blocked: null };
    const backup = routing.fallback;
    if (backup && !this.registry.providerBlockedReason(backup.provider, sandboxReady)) {
      return {
        ...routing,
        primary: backup,
        fallback: null,
        note: `${routing.primary.name} routes to Antigravity, which is off. Running on ${backup.name} (${backup.provider}) instead. Turn Antigravity on in Providers to use it.`,
        blocked: null,
      };
    }
    return { ...routing, note: null, blocked: reason };
  }

  private buildDispatchPreviews(plan: PlanDTO, sandboxReady: boolean): TaskDispatchPreviewDTO[] {
    const statusByExternal = new Map(plan.tasks.map((t) => [t.externalId, t.status]));
    return plan.tasks.map((task) => {
      const pendingDeps = task.dependsOn.filter((dep) => statusByExternal.get(dep) !== 'done');
      const dependenciesSatisfied = pendingDeps.length === 0;
      const routing = this.routeTask(task, sandboxReady);

      let blockedReason: string | null = null;
      if (plan.status !== 'approved') {
        blockedReason = 'Plan is not approved yet';
      } else if (task.status === 'done') {
        blockedReason = null;
      } else if (task.status === 'running') {
        blockedReason = 'Currently running';
      } else if (task.status === 'failed' || task.status === 'stopped') {
        blockedReason = `Task is ${task.status}; use Retry or Resume`;
      } else if (!dependenciesSatisfied) {
        blockedReason = `Waiting on ${pendingDeps.join(', ')}`;
      }

      const eligible =
        plan.status === 'approved' &&
        task.status === 'approved' &&
        dependenciesSatisfied &&
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
        dependenciesSatisfied,
        eligible,
        blockedReason,
        resolvedProfileId: routing.primary.id,
        resolvedProfileName: routing.primary.name,
        resolvedProvider: routing.primary.provider,
        resolvedModel: routing.primary.model,
        fallbackProfileId: routing.fallback?.id ?? null,
        fallbackProfileName: routing.fallback?.name ?? null,
        selectionSource: routing.source,
        selectionNote: routing.note,
      };
    });
  }

  startExecution(
    projectId: string,
    input: Partial<StartExecutionInput> = {},
  ): Promise<{ started: boolean; run: TaskRunDTO | null; queueMode: boolean }> {
    this.getProjectRow(projectId);
    if (this.activeProjects.has(projectId)) {
      return Promise.reject(new Error('An execution run is already in progress for this project.'));
    }

    // Reserve the slot before the first await, so two quick requests cannot both start a run.
    const reservation: ActiveProjectExecution = {
      runId: '',
      taskId: '',
      queueMode: false,
      queueCancelled: false,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.activeProjects.set(projectId, reservation);

    return this.startExecutionReserved(projectId, input).catch((err) => {
      if (this.activeProjects.get(projectId) === reservation) this.activeProjects.delete(projectId);
      throw err;
    });
  }

  private async startExecutionReserved(
    projectId: string,
    input: Partial<StartExecutionInput>,
  ): Promise<{ started: boolean; run: TaskRunDTO | null; queueMode: boolean }> {
    const allowUnconfined = Boolean(input.allowUnconfined);
    const resumeSession = Boolean(input.resumeSession);
    const sandboxReady = await this.registry.isSandboxReady();
    if (!sandboxReady && !allowUnconfined) {
      throw new Error(
        `Bubblewrap sandbox is unavailable on ${process.platform}. Confirm unconfined execution to run tasks without sandbox confinement.`,
      );
    }

    const plan = this.leadService.getPlan(projectId);
    if (!plan) throw new Error('No plan exists yet. Generate and approve a plan in List first.');
    if (plan.status !== 'approved') {
      throw new Error('Plan must be approved in List before execution can start.');
    }

    if (input.taskId) {
      const target = plan.tasks.find((t) => t.id === input.taskId || t.externalId === input.taskId);
      if (!target) throw new Error(`Task not found: ${input.taskId}`);
      if (target.status === 'running') {
        throw new Error(`Task ${target.externalId} is already running.`);
      }

      const statusByExt = new Map(plan.tasks.map((t) => [t.externalId, t.status]));
      const unmet = target.dependsOn.filter((d) => statusByExt.get(d) !== 'done');
      if (unmet.length > 0) {
        throw new Error(
          `Cannot run ${target.externalId}: waiting for dependencies ${unmet.join(', ')} to finish.`,
        );
      }

      let resumeSessionId: string | null = null;
      if (resumeSession) {
        const routing = this.routeTask(target, sandboxReady);
        const prevRuns = this.db
          .select()
          .from(runs)
          .where(eq(runs.taskId, target.id))
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

      const launched = await this.launchSingleTask(projectId, target, {
        queueMode: false,
        resumeSessionId,
      });
      return { started: true, run: launched.initialRun, queueMode: false };
    }

    // Sequential queue mode: pick first eligible approved task
    const previews = this.buildDispatchPreviews(plan, sandboxReady);
    const firstEligible = previews.find((p) => p.eligible);
    if (!firstEligible) {
      const allDone = plan.tasks.every((t) => t.status === 'done');
      if (allDone) {
        throw new Error('All tasks in this plan are already done.');
      }
      throw new Error(
        'No eligible approved tasks to dispatch. Check blocked dependencies or retry failed/stopped tasks.',
      );
    }

    const firstTask = plan.tasks.find((t) => t.id === firstEligible.taskId)!;
    const launched = await this.launchQueue(projectId, firstTask);
    return { started: true, run: launched, queueMode: true };
  }

  async waitForProjectExecution(projectId: string): Promise<void> {
    const active = this.activeProjects.get(projectId);
    if (active) {
      await active.promise;
    }
  }

  async stopExecution(projectId: string): Promise<{ stopped: boolean }> {
    const active = this.activeProjects.get(projectId);
    if (!active) {
      return { stopped: false };
    }
    active.queueCancelled = true;
    active.controller.abort();
    await active.promise.catch(() => undefined);
    return { stopped: true };
  }

  async stopAll(): Promise<void> {
    const projectIds = [...this.activeProjects.keys()];
    await Promise.all(projectIds.map((pid) => this.stopExecution(pid)));
  }

  private async launchQueue(projectId: string, firstTask: TaskDTO): Promise<TaskRunDTO> {
    const controller = new AbortController();
    const { runId, initialRun, executeFn } = await this.prepareTaskExecution(
      projectId,
      firstTask,
      controller,
      null,
    );

    const execHandle: ActiveProjectExecution = {
      runId,
      taskId: firstTask.id,
      queueMode: true,
      queueCancelled: false,
      controller,
      promise: Promise.resolve(),
    };
    this.activeProjects.set(projectId, execHandle);

    execHandle.promise = (async () => {
      try {
        const firstStatus = await executeFn();
        if (execHandle.queueCancelled || firstStatus === 'stopped' || firstStatus === 'failed') {
          return;
        }

        while (!execHandle.queueCancelled) {
          const latestPlan = this.leadService.getPlan(projectId);
          if (!latestPlan) break;
          const sandboxNow = await this.registry.isSandboxReady();
          const nextPreview = this.buildDispatchPreviews(latestPlan, sandboxNow).find((p) => p.eligible);
          if (!nextPreview) break;

          const nextTask = latestPlan.tasks.find((t) => t.id === nextPreview.taskId);
          if (!nextTask) break;

          const nextCtrl = new AbortController();
          execHandle.controller = nextCtrl;
          const nextPrep = await this.prepareTaskExecution(projectId, nextTask, nextCtrl, null);
          execHandle.runId = nextPrep.runId;
          execHandle.taskId = nextTask.id;

          const nextStatus = await nextPrep.executeFn();
          if (execHandle.queueCancelled || nextStatus === 'stopped' || nextStatus === 'failed') {
            break;
          }
        }
      } catch (err) {
        this.events?.emitEvent({
          type: 'run.finished',
          projectId,
          taskId: execHandle.taskId,
          runId: execHandle.runId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (this.activeProjects.get(projectId) === execHandle) {
          this.activeProjects.delete(projectId);
        }
      }
    })();

    return initialRun;
  }

  private async launchSingleTask(
    projectId: string,
    task: TaskDTO,
    opts: { queueMode: boolean; resumeSessionId: string | null },
  ): Promise<{ initialRun: TaskRunDTO }> {
    const controller = new AbortController();
    const { runId, initialRun, executeFn } = await this.prepareTaskExecution(
      projectId,
      task,
      controller,
      opts.resumeSessionId,
    );

    const execHandle: ActiveProjectExecution = {
      runId,
      taskId: task.id,
      queueMode: opts.queueMode,
      queueCancelled: false,
      controller,
      promise: Promise.resolve(),
    };
    this.activeProjects.set(projectId, execHandle);

    execHandle.promise = (async () => {
      try {
        await executeFn();
      } catch (err) {
        this.events?.emitEvent({
          type: 'run.finished',
          projectId,
          taskId: execHandle.taskId,
          runId: execHandle.runId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (this.activeProjects.get(projectId) === execHandle) {
          this.activeProjects.delete(projectId);
        }
      }
    })();

    return { initialRun };
  }

  private selectProfileRespectingLimit(
    primary: AgentProfileDTO,
    fallback: AgentProfileDTO | null,
  ): { chosen: AgentProfileDTO; fallback: AgentProfileDTO | null; usedFallback: boolean } {
    const activePrimary = this.getProviderActiveCount(primary.provider);
    if (activePrimary < primary.maxParallel) {
      return { chosen: primary, fallback, usedFallback: false };
    }
    if (fallback && this.getProviderActiveCount(fallback.provider) < fallback.maxParallel) {
      return { chosen: fallback, fallback: null, usedFallback: true };
    }
    throw new Error(
      `Provider ${primary.provider} is at max parallel limit (${primary.maxParallel}) and no backup profile is available.`,
    );
  }

  private async prepareTaskExecution(
    projectId: string,
    task: TaskDTO,
    controller: AbortController,
    resumeSessionId: string | null,
  ): Promise<{
    runId: string;
    initialRun: TaskRunDTO;
    executeFn: () => Promise<RunStatus>;
  }> {
    const project = this.getProjectRow(projectId);
    const sandboxReady = await this.registry.isSandboxReady();
    const routing = this.routeTask(task, sandboxReady);
    if (routing.blocked) throw new Error(routing.blocked);
    const selected = this.selectProfileRespectingLimit(routing.primary, routing.fallback);

    const logsDir = getProjectLogsDir(project.path);
    const taskArtDir = getTaskArtifactDir(project.path, task.externalId);
    ensureProjectDir(project.path, logsDir);
    ensureProjectDir(project.path, taskArtDir);

    const relResultPath = path.join('.dalang', 'tasks', task.externalId, 'result.json');
    const absResultPath = path.join(project.path, relResultPath);
    // Clear stale result.json before checkpointing so only an output written by this run counts.
    removeArtifactFile(project.path, absResultPath);

    const checkpointBefore = await createGitCheckpoint(
      project.path,
      `dalang: checkpoint before ${task.externalId}`,
    );

    const existingAttempts = this.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .all().length;

    const runId = crypto.randomUUID();
    const attempt = existingAttempts + 1;
    const relLogPath = path.join('.dalang', 'logs', `run-${task.externalId}-${Date.now()}.log`);
    const absLogPath = path.join(project.path, relLogPath);

    const now = new Date().toISOString();
    this.db
      .insert(runs)
      .values({
        id: runId,
        projectId,
        taskId: task.id,
        profileId: selected.chosen.id,
        provider: selected.chosen.provider,
        model: selected.chosen.model || null,
        status: 'running',
        cliSessionId: resumeSessionId,
        attempt,
        usedFallback: selected.usedFallback,
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        failureReason: null,
        commitBefore: checkpointBefore.commitSha,
        commitAfter: null,
        logPath: relLogPath,
        resultPath: null,
        scopeWarningsJson: '[]',
      })
      .run();

    this.db
      .update(tasks)
      .set({ status: 'running', updatedAt: now })
      .where(eq(tasks.id, task.id))
      .run();

    this.events?.emitEvent({
      type: 'run.started',
      projectId,
      taskId: task.id,
      runId,
      profileName: selected.chosen.name,
      provider: selected.chosen.provider,
    });
    this.events?.emitEvent({ type: 'plan.updated', projectId });

    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get()!;
    const initialRun = this.toRunDTO(project.path, row, task, selected.chosen);

    const executeFn = async (): Promise<RunStatus> => {
      return this.executePreparedRun({
        projectId,
        projectPath: project.path,
        task,
        initialRunId: runId,
        initialProfile: selected.chosen,
        fallbackProfile: selected.fallback,
        sandboxReady,
        routeNote: routing.note,
        attempt,
        commitBefore: checkpointBefore.commitSha,
        absLogPath,
        relLogPath,
        absResultPath,
        relResultPath,
        resumeSessionId,
        controller,
      });
    };

    return { runId, initialRun, executeFn };
  }

  private async executePreparedRun(ctx: {
    projectId: string;
    projectPath: string;
    task: TaskDTO;
    initialRunId: string;
    initialProfile: AgentProfileDTO;
    fallbackProfile: AgentProfileDTO | null;
    sandboxReady: boolean;
    routeNote: string | null;
    attempt: number;
    commitBefore: string;
    absLogPath: string;
    relLogPath: string;
    absResultPath: string;
    relResultPath: string;
    resumeSessionId: string | null;
    controller: AbortController;
  }): Promise<RunStatus> {
    const runAttempt = async (
      runId: string,
      profile: AgentProfileDTO,
      logFileAbs: string,
      sessionToResume: string | null,
    ): Promise<{
      status: RunStatus;
      canFallback: boolean;
      failureEventType?: 'rate_limit' | 'login_expired' | 'timeout' | 'error';
      failureReason?: string;
    }> => {
      const adapter = this.registry.getAdapter(profile.provider);
      let capturedSessionId: string | null = sessionToResume;
      let exitCode: number | null = null;
      let stdout = '';
      let stderr = '';
      let aborted = false;
      let thrownError: string | undefined;

      this.incrementProviderCount(profile.provider);
      const emitDalangLine = (line: string) => {
        this.appendDalangLog(logFileAbs, line);
        this.events?.emitEvent({
          type: 'run.log',
          projectId: ctx.projectId,
          taskId: ctx.task.id,
          runId,
          line,
        });
      };
      const emitAdapterLine = (line: string) => {
        this.events?.emitEvent({
          type: 'run.log',
          projectId: ctx.projectId,
          taskId: ctx.task.id,
          runId,
          line,
        });
      };
      const markRunStopped = async (): Promise<{ status: RunStatus; canFallback: false }> => {
        const checkpointAfter = await createGitCheckpoint(
          ctx.projectPath,
          `dalang: checkpoint stopped ${ctx.task.externalId}`,
        ).catch(() => ({ commitSha: ctx.commitBefore }));
        const finishedAt = new Date().toISOString();
        this.db
          .update(runs)
          .set({
            status: 'stopped',
            finishedAt,
            exitCode,
            failureReason: 'Stopped by user',
            commitAfter: checkpointAfter.commitSha,
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'stopped', updatedAt: finishedAt })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: ctx.projectId,
          taskId: ctx.task.id,
          runId,
          status: 'stopped',
          error: 'Stopped by user',
        });
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
        return { status: 'stopped', canFallback: false };
      };

      try {
        emitDalangLine(
          `[dalang] Starting ${ctx.task.externalId} (${ctx.task.title}) with profile "${profile.name}" (${profile.provider}${profile.model ? `/${profile.model}` : ''})`,
        );

        if (ctx.routeNote) emitDalangLine(`[dalang] ${ctx.routeNote}`);

        const prompt = sessionToResume
          ? this.buildResumePrompt(ctx.task, ctx.relResultPath)
          : this.buildTaskPrompt(ctx.task, profile, ctx.relResultPath);

        const turn = await adapter.runTurn({
          projectPath: ctx.projectPath,
          prompt,
          sessionId: sessionToResume,
          model: profile.model || null,
          effort: profile.effort,
          permissionMode: writePermission(profile),
          timeoutMs: profile.timeoutMs,
          idleTimeoutMs: profile.idleTimeoutMs,
          signal: ctx.controller.signal,
          logFilePath: logFileAbs,
          onLogLine: emitAdapterLine,
        });

        capturedSessionId = turn.sessionId ?? capturedSessionId;
        exitCode = turn.exitCode;
        stdout = turn.stdout;
        stderr = turn.stderr;
        aborted = Boolean(turn.aborted) || ctx.controller.signal.aborted;
      } catch (err) {
        aborted = ctx.controller.signal.aborted;
        thrownError = err instanceof Error ? err.message : String(err);
        emitDalangLine(`[dalang:error] ${thrownError}`);
      } finally {
        this.decrementProviderCount(profile.provider);
      }

      if (capturedSessionId) {
        this.db
          .update(runs)
          .set({ cliSessionId: capturedSessionId })
          .where(eq(runs.id, runId))
          .run();
      }

      if (aborted) {
        return markRunStopped();
      }

      if (thrownError || (exitCode !== null && exitCode !== 0)) {
        const classified = classifyProviderFailure(exitCode, stdout, stderr, thrownError);
        this.db
          .insert(providerEvents)
          .values({
            id: crypto.randomUUID(),
            provider: profile.provider,
            type: classified.eventType,
            detail: classified.reason.slice(0, 300),
            createdAt: new Date().toISOString(),
          })
          .run();

        const checkpointAfter = await createGitCheckpoint(
          ctx.projectPath,
          `dalang: checkpoint failed ${ctx.task.externalId}`,
        ).catch(() => ({ commitSha: ctx.commitBefore }));
        const finishedAt = new Date().toISOString();
        this.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt,
            exitCode,
            failureReason: classified.reason,
            commitAfter: checkpointAfter.commitSha,
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'failed', updatedAt: finishedAt })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: ctx.projectId,
          taskId: ctx.task.id,
          runId,
          status: 'failed',
          error: classified.reason,
        });
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });

        return {
          status: 'failed',
          canFallback: true,
          failureEventType: classified.eventType,
          failureReason: classified.reason,
        };
      }

      // Validate .dalang/tasks/{id}/result.json (repair once if missing/invalid and not aborted)
      let validation = this.validateResultFile(
        ctx.projectPath,
        ctx.absResultPath,
        ctx.task.externalId,
      );
      if (!validation.ok && !ctx.controller.signal.aborted) {
        emitDalangLine(`[dalang] ${validation.error}; requesting structured result.json repair...`);
        const jsonSchema = z.toJSONSchema(TaskResultContractSchema);
        const repairPrompt = [
          `Your task work finished, but the required contract file failed validation:`,
          validation.error,
          ``,
          `Please write a valid JSON file directly to "${ctx.relResultPath}" matching this JSON Schema:`,
          JSON.stringify(jsonSchema, null, 2),
        ].join('\n');

        this.incrementProviderCount(profile.provider);
        try {
          const repairTurn = await adapter.runTurn({
            projectPath: ctx.projectPath,
            prompt: repairPrompt,
            sessionId: capturedSessionId,
            model: profile.model || null,
            effort: profile.effort,
            permissionMode: writePermission(profile),
            timeoutMs: Math.min(profile.timeoutMs, 180_000),
            idleTimeoutMs: profile.idleTimeoutMs,
            signal: ctx.controller.signal,
            logFilePath: logFileAbs,
            onLogLine: emitAdapterLine,
          });
          if (repairTurn.sessionId) {
            capturedSessionId = repairTurn.sessionId;
            this.db
              .update(runs)
              .set({ cliSessionId: capturedSessionId })
              .where(eq(runs.id, runId))
              .run();
          }
          if (repairTurn.aborted || ctx.controller.signal.aborted) {
            aborted = true;
          }
        } catch (err) {
          aborted = ctx.controller.signal.aborted;
          emitDalangLine(
            `[dalang:error] Repair turn failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          this.decrementProviderCount(profile.provider);
        }
        if (aborted) {
          return markRunStopped();
        }
        validation = this.validateResultFile(
          ctx.projectPath,
          ctx.absResultPath,
          ctx.task.externalId,
        );
      }

      let scopeWarnings: string[];
      try {
        const changedFiles = await getChangedFilesSinceCommit(ctx.projectPath, ctx.commitBefore);
        scopeWarnings = findScopeViolations(changedFiles, ctx.task.filesAllowed);
      } catch (err) {
        scopeWarnings = [
          `Could not verify files_allowed: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
      for (const warn of scopeWarnings) {
        emitDalangLine(`[dalang:warn] ${warn}`);
      }

      if (!validation.ok) {
        const checkpointAfter = await createGitCheckpoint(
          ctx.projectPath,
          `dalang: checkpoint invalid-result ${ctx.task.externalId}`,
        ).catch(() => ({ commitSha: ctx.commitBefore }));
        const finishedAt = new Date().toISOString();
        this.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt,
            exitCode,
            failureReason: validation.error,
            commitAfter: checkpointAfter.commitSha,
            scopeWarningsJson: JSON.stringify(scopeWarnings),
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(tasks)
          .set({ status: 'failed', updatedAt: finishedAt })
          .where(eq(tasks.id, ctx.task.id))
          .run();
        this.events?.emitEvent({
          type: 'run.finished',
          projectId: ctx.projectId,
          taskId: ctx.task.id,
          runId,
          status: 'failed',
          error: validation.error,
        });
        this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
        // The agent ran but did not deliver a valid result: another provider would only repeat the cost.
        return {
          status: 'failed',
          canFallback: false,
          failureEventType: 'error',
          failureReason: validation.error,
        };
      }

      const resultData = validation.data;
      const succeeded = resultData.status === 'completed';
      const finalRunStatus: RunStatus = succeeded ? 'completed' : 'failed';
      const finalTaskStatus: TaskStatus = succeeded ? 'done' : 'failed';
      const failureReason = succeeded
        ? null
        : resultData.blockers.join('; ') || `Task reported status "${resultData.status}"`;

      const checkpointAfter = await createGitCheckpoint(
        ctx.projectPath,
        `dalang: ${ctx.task.externalId} (${finalTaskStatus})`,
      );
      const finishedAt = new Date().toISOString();

      this.db
        .update(runs)
        .set({
          status: finalRunStatus,
          finishedAt,
          exitCode,
          failureReason,
          commitAfter: checkpointAfter.commitSha,
          resultPath: ctx.relResultPath,
          scopeWarningsJson: JSON.stringify(scopeWarnings),
        })
        .where(eq(runs.id, runId))
        .run();

      this.db
        .update(tasks)
        .set({ status: finalTaskStatus, updatedAt: finishedAt })
        .where(eq(tasks.id, ctx.task.id))
        .run();

      emitDalangLine(
        `[dalang] Finished ${ctx.task.externalId} -> ${finalTaskStatus} (checkpoint ${checkpointAfter.commitSha.slice(0, 7)})`,
      );
      this.events?.emitEvent({
        type: 'run.finished',
        projectId: ctx.projectId,
        taskId: ctx.task.id,
        runId,
        status: finalRunStatus,
        ...(failureReason ? { error: failureReason } : {}),
      });
      this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });
      // A task the agent reports as blocked or failed is a real outcome, not a provider failure, so no fallback.
      return { status: finalRunStatus, canFallback: false, failureReason: failureReason ?? undefined };
    };

    const primaryOutcome = await runAttempt(
      ctx.initialRunId,
      ctx.initialProfile,
      ctx.absLogPath,
      ctx.resumeSessionId,
    );

    if (
      primaryOutcome.status === 'failed' &&
      primaryOutcome.canFallback &&
      ctx.fallbackProfile &&
      !ctx.controller.signal.aborted &&
      !this.registry.providerBlockedReason(ctx.fallbackProfile.provider, ctx.sandboxReady) &&
      this.getProviderActiveCount(ctx.fallbackProfile.provider) < ctx.fallbackProfile.maxParallel
    ) {
      // Create a fresh run row using the fallback profile (F-13)
      const fbRunId = crypto.randomUUID();
      const fbRelLog = path.join(
        '.dalang',
        'logs',
        `run-${ctx.task.externalId}-fb-${Date.now()}.log`,
      );
      const fbAbsLog = path.join(ctx.projectPath, fbRelLog);
      removeArtifactFile(ctx.projectPath, ctx.absResultPath);

      const fbNow = new Date().toISOString();
      this.db
        .insert(runs)
        .values({
          id: fbRunId,
          projectId: ctx.projectId,
          taskId: ctx.task.id,
          profileId: ctx.fallbackProfile.id,
          provider: ctx.fallbackProfile.provider,
          model: ctx.fallbackProfile.model || null,
          status: 'running',
          cliSessionId: null,
          attempt: ctx.attempt + 1,
          usedFallback: true,
          startedAt: fbNow,
          finishedAt: null,
          exitCode: null,
          failureReason: null,
          commitBefore: ctx.commitBefore,
          commitAfter: null,
          logPath: fbRelLog,
          resultPath: null,
          scopeWarningsJson: '[]',
        })
        .run();

      this.db
        .update(tasks)
        .set({ status: 'running', updatedAt: fbNow })
        .where(eq(tasks.id, ctx.task.id))
        .run();

      this.events?.emitEvent({
        type: 'run.started',
        projectId: ctx.projectId,
        taskId: ctx.task.id,
        runId: fbRunId,
        profileName: ctx.fallbackProfile.name,
        provider: ctx.fallbackProfile.provider,
      });
      const fallbackBanner = `[dalang] Fallback triggered after ${ctx.initialProfile.name} failed (${primaryOutcome.failureReason ?? 'error'}). Switching to "${ctx.fallbackProfile.name}" (${ctx.fallbackProfile.provider}).`;
      this.appendDalangLog(fbAbsLog, fallbackBanner);
      this.events?.emitEvent({
        type: 'run.log',
        projectId: ctx.projectId,
        taskId: ctx.task.id,
        runId: fbRunId,
        line: fallbackBanner,
      });
      this.events?.emitEvent({ type: 'plan.updated', projectId: ctx.projectId });

      const fbOutcome = await runAttempt(fbRunId, ctx.fallbackProfile, fbAbsLog, null);
      return fbOutcome.status;
    }

    return primaryOutcome.status;
  }

  private validateResultFile(
    projectPath: string,
    absResultPath: string,
    expectedTaskId: string,
  ): { ok: true; data: TaskResultContract } | { ok: false; error: string } {
    const rel = path.relative(projectPath, absResultPath);
    if (!fs.existsSync(absResultPath)) {
      return { ok: false, error: `Expected result file was not written at ${rel}` };
    }
    let raw: string;
    try {
      raw = readArtifactFile(projectPath, absResultPath).trim();
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
  ): string {
    const jsonSchema = z.toJSONSchema(TaskResultContractSchema);
    return [
      `You are executing task ${task.externalId}: "${task.title}" (milestone ${task.milestone}) for a project managed by DALANG.`,
      profile.rolePrompt ? `Role instructions: ${profile.rolePrompt}` : '',
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

  private buildResumePrompt(task: TaskDTO, relResultPath: string): string {
    return [
      `Resume work on task ${task.externalId}: "${task.title}".`,
      `Verify command to run before finishing: ${task.verify}`,
      `When finished, write the updated result JSON to "${relResultPath}" with task_id "${task.externalId}".`,
    ].join('\n');
  }

  getRunLog(projectId: string, runId: string): { runId: string; logPath: string; content: string } {
    const project = this.getProjectRow(projectId);
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row || row.projectId !== projectId) {
      throw new Error(`Run not found: ${runId}`);
    }
    const absLog = path.join(project.path, row.logPath);
    if (!fs.existsSync(absLog)) {
      return { runId: row.id, logPath: row.logPath, content: '' };
    }
    const content = readArtifactFile(project.path, absLog);
    return { runId: row.id, logPath: row.logPath, content };
  }

  async rollbackRun(projectId: string, runId: string): Promise<TaskRunDTO> {
    const project = this.getProjectRow(projectId);
    if (this.activeProjects.has(projectId)) {
      throw new Error('Stop the active run before rolling back a checkpoint.');
    }

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

    // `git reset --hard` is destructive: only run it when the repo still ends where DALANG left it.
    const state = await getRepoState(project.path);
    const lastKnown = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), ne(runs.status, 'rolled_back'), ne(runs.status, 'running')))
      .orderBy(desc(runs.startedAt), desc(runs.attempt))
      .all()
      .find((r) => r.commitAfter);
    if (lastKnown?.commitAfter && state.head !== lastKnown.commitAfter) {
      throw new Error(
        'The repository has commits that DALANG did not create after the last run. Roll back manually with git.',
      );
    }
    if (state.dirtyFiles.length > 0) {
      throw new Error(
        `Uncommitted changes would be lost (${state.dirtyFiles.slice(0, 3).join(', ')}). Commit or stash them first.`,
      );
    }

    await rollbackGitToCheckpoint(project.path, row.commitBefore);

    const now = new Date().toISOString();
    // Mark this run and any subsequent project runs whose commits were discarded by the reset.
    const projectRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(
            gte(runs.startedAt, row.startedAt),
            eq(runs.id, row.id),
          ),
        ),
      )
      .all();

    const rolledBackRunIds: string[] = [];
    const affectedTaskIds = new Set<string>([row.taskId]);
    for (const r of projectRuns) {
      if (r.status === 'rolled_back') continue;
      if (r.startedAt > row.startedAt || (r.startedAt === row.startedAt && r.attempt >= row.attempt) || r.id === row.id) {
        rolledBackRunIds.push(r.id);
        affectedTaskIds.add(r.taskId);
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
        .set({ status: 'approved', updatedAt: now })
        .where(
          and(
            inArray(tasks.id, [...affectedTaskIds]),
            inArray(tasks.status, ['done', 'failed', 'stopped']),
          ),
        )
        .run();
    }

    this.events?.emitEvent({ type: 'plan.updated', projectId });

    const updatedRow = this.db.select().from(runs).where(eq(runs.id, row.id)).get()!;
    const plan = this.leadService.getPlan(projectId);
    const task = plan?.tasks.find((t) => t.id === row.taskId);
    const profile = this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, row.profileId))
      .get();
    return this.toRunDTO(
      project.path,
      updatedRow,
      task,
      profile
        ? {
            id: profile.id,
            name: profile.name,
            provider: profile.provider as ProviderId,
            model: profile.model,
            effort: profile.effort as 'low' | 'medium' | 'high',
            rolePrompt: profile.rolePrompt,
            permissionMode: profile.permissionMode as 'workspace-write' | 'read-only' | 'accept-edits',
            timeoutMs: profile.timeoutMs,
            idleTimeoutMs: profile.idleTimeoutMs,
            maxParallel: profile.maxParallel,
            isDefault: Boolean(profile.isDefault),
            createdAt: profile.createdAt,
          }
        : undefined,
    );
  }

  private toRunDTO(
    projectPath: string,
    row: typeof runs.$inferSelect,
    task?: TaskDTO,
    profile?: AgentProfileDTO,
  ): TaskRunDTO {
    let result: TaskResultContract | null = null;
    if (row.resultPath) {
      const absResult = path.join(projectPath, row.resultPath);
      if (fs.existsSync(absResult)) {
        try {
          const parsed = JSON.parse(readArtifactFile(projectPath, absResult)) as unknown;
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
      model: row.model,
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
      logPath: row.logPath,
      resultPath: row.resultPath,
      result,
      scopeWarnings,
    };
  }
}
