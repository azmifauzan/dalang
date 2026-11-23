import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  AskReplyContractSchema,
  MAX_CHAT_IMAGE_BYTES,
  BriefContentSchema,
  DiscussRoundSchema,
  PlanContractSchema,
  QuickPlanContractSchema,
  TaskSplitOutputSchema,
  type AskMessageContent,
  type BriefContent,
  type BriefDTO,
  type ChatMessageInput,
  type ChatImage,
  type ChatImageMessage,
  type EffortLevel,
  type SessionTurnDTO,
  type CreateSessionInput,
  type CreateTaskInput,
  type DiscussMessageDTO,
  type DiscussMessageInput,
  type DiscussRound,
  type EditableTaskStatus,
  type ModeSuggestion,
  type PlanContract,
  type PlanDTO,
  type PlanMilestone,
  type PlanTaskContract,
  type PlanTaskRole,
  type ProviderId,
  type QuickPlanContract,
  type QuickPlanMessageContent,
  type ReorderTasksInput,
  type SessionDetailDTO,
  type SessionMessageType,
  type SessionMode,
  type SessionPhase,
  type SessionSummaryDTO,
  type SessionWorkState,
  type TaskComplexity,
  type TaskDTO,
  type TaskStatus,
  type UiLanguage,
  type UpdateSessionInput,
  type UpdateTaskInput,
} from '@dalang/shared';
import type { ProviderRegistry } from '../adapters/registry.js';
import type { TurnImage, TurnTokenUsage } from '../adapters/types.js';
import type { DalangDb } from '../db/client.js';
import {
  briefs,
  leadTurns,
  messageImages,
  messages,
  plans,
  projects,
  runs,
  sessions,
  taskDependencies,
  tasks,
} from '../db/schema.js';
import {
  getProjectTmpDir,
  getSessionDir,
  getSessionDiscussDir,
  getSessionLogsDir,
  getSessionTmpDir,
} from '../paths.js';
import { ensureProjectDir, readArtifactFile, writeArtifactFile } from '../safe-fs.js';
import { runContractTurn } from './contract.js';
import type { DalangEvent, DalangEventBus } from './events.js';
import { mergeTokenUsage, usageDbFields } from './pricing.js';
import { extractJsonCandidate } from './review.js';

export const MAX_SPLIT_DEPTH = 2;

const MODE_RANK: Record<SessionMode, number> = {
  ask: 0,
  quick: 1,
  full: 2,
};

const UNFINISHED_TASK_STATUSES = new Set<string>([
  'running',
  'reviewing',
  'awaiting_merge',
  'review_failed',
]);

type ChatTurnImage = TurnImage & { name: string };

function decodeChatImages(images: ChatImage[]): ChatTurnImage[] {
  return images.map(({ name, mimeType, data }) => {
    const bytes = Buffer.from(data, 'base64');
    const mimeMatches = mimeType === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mimeType === 'image/jpeg'
        ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!mimeMatches || bytes.length > MAX_CHAT_IMAGE_BYTES || bytes.toString('base64') !== data) {
      throw new Error('Invalid image. Use a PNG, JPEG, or WebP file up to 4 MiB.');
    }
    return { name, mimeType, data: bytes };
  });
}

export function conflictError(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 409;
  return err;
}

export function deriveSessionTitle(raw: string, fallback = 'New chat'): string {
  const cleaned = raw.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

export function hasDependencyCycle(
  edges: Map<string, string[]>,
  sourceId: string,
  candidateDeps: string[],
): boolean {
  const nextEdges = new Map(edges);
  nextEdges.set(sourceId, candidateDeps);

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const dfs = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dep of nextEdges.get(nodeId) ?? []) {
      if (dep === nodeId || dfs(dep)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return dfs(sourceId);
}

export function buildLanguageInstruction(language: UiLanguage): string {
  if (language === 'id') {
    return 'Language: Write all human-readable prose (answers, questions, options, reasons, summaries, brief fields, milestone titles and descriptions, task titles, goals, and acceptance criteria) in clear, natural Indonesian (Bahasa Indonesia). Keep JSON keys, enum values, code, file paths, and verify commands in English.';
  }
  return 'Language: Write all human-readable prose in clear English. Keep JSON keys, enum values, code, file paths, and verify commands in English.';
}

export interface ChatTurnResult {
  session: SessionSummaryDTO;
  mode: SessionMode;
  askReply?: AskMessageContent;
  quickPlan?: QuickPlanContract;
  plan?: PlanDTO | null;
  round?: DiscussRound;
  messages: DiscussMessageDTO[];
}

export class LeadService {
  private readonly activeTurns = new Set<string>();

  constructor(
    private readonly db: DalangDb,
    private readonly registry: ProviderRegistry,
    private readonly events?: DalangEventBus,
    private readonly getLanguage: () => UiLanguage = () => 'en',
  ) {
    this.events?.onEvent((event) => this.trackTurn(event));
  }

  /** Lead turns running now, by session. Lives in memory: a restart ends the CLI process too. */
  private readonly runningTurns = new Map<string, SessionTurnDTO>();

  private trackTurn(event: DalangEvent): void {
    if (event.type === 'lead.turn_started' && event.sessionId) {
      this.runningTurns.set(event.sessionId, {
        phase: event.phase,
        provider: event.provider as ProviderId,
        startedAt: new Date().toISOString(),
      });
    } else if (event.type === 'lead.turn_finished' && event.sessionId) {
      if (!this.runningTurns.delete(event.sessionId)) return;
    } else {
      return;
    }
    // Tell open pages so the running state shows up, or goes away, without a reload.
    this.events?.emitEvent({
      type: 'sessions.updated',
      projectId: event.projectId,
      sessionId: event.sessionId,
    });
  }

  /** One Lead turn per project at a time: turns share a CLI session and write numbered artifacts. */
  private async exclusiveTurn<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    if (this.activeTurns.has(projectId)) {
      throw new Error('The Lead is still working on this project. Wait for the current turn to finish.');
    }
    this.activeTurns.add(projectId);
    try {
      return await run();
    } finally {
      this.activeTurns.delete(projectId);
    }
  }

  // ---------------------------------------------------------------------------
  // Session management (v0.7)
  // ---------------------------------------------------------------------------

  listSessions(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): SessionSummaryDTO[] {
    this.getProjectRow(projectId);
    const rows = this.db
      .select()
      .from(sessions)
      .where(
        opts.includeArchived
          ? eq(sessions.projectId, projectId)
          : and(eq(sessions.projectId, projectId), isNull(sessions.archivedAt)),
      )
      .orderBy(desc(sessions.updatedAt))
      .all();

    return rows.map((row) => this.toSessionSummary(row));
  }

  getSession(projectId: string, sessionId: string): SessionSummaryDTO {
    const row = this.getSessionRow(projectId, sessionId);
    return this.toSessionSummary(row);
  }

  getSessionRow(projectId: string, sessionId: string) {
    this.getProjectRow(projectId);
    const row = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
      .get();
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return row;
  }

  getWorkingSession(projectId: string): SessionSummaryDTO | null {
    const row = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), eq(sessions.workState, 'working')))
      .get();
    return row ? this.toSessionSummary(row) : null;
  }

  createSession(projectId: string, input: Partial<CreateSessionInput> = {}): SessionSummaryDTO {
    const project = this.getProjectRow(projectId);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const mode: SessionMode = input.mode ?? 'ask';
    const provider: ProviderId = input.provider ?? (project.leadProvider as ProviderId);
    const model = input.model !== undefined ? (input.model?.trim() || null) : project.leadModel;
    const title = input.title?.trim() ? deriveSessionTitle(input.title) : '';

    this.db
      .insert(sessions)
      .values({
        id,
        projectId,
        title,
        mode,
        workState: 'idle',
        phase: 'discuss',
        provider,
        model,
        cliSessionId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: id });
    return this.getSession(projectId, id);
  }

  updateSession(
    projectId: string,
    sessionId: string,
    input: UpdateSessionInput,
  ): SessionSummaryDTO {
    const row = this.getSessionRow(projectId, sessionId);
    if (input.archived === true && row.workState === 'working') {
      throw conflictError(
        `Cannot archive session "${row.title || 'Untitled session'}" while it has unfinished work. Merge or discard its work first.`,
      );
    }

    const nextProvider = input.provider ?? (row.provider as ProviderId);
    const nextModel =
      input.model !== undefined ? (input.model?.trim() || null) : row.model;
    const nextCliSessionId =
      nextProvider !== row.provider ? null : row.cliSessionId;

    const now = new Date().toISOString();
    this.db
      .update(sessions)
      .set({
        ...(input.title !== undefined ? { title: deriveSessionTitle(input.title, row.title || 'New chat') } : {}),
        ...(input.archived !== undefined
          ? { archivedAt: input.archived ? now : null }
          : {}),
        ...(input.provider !== undefined ? { provider: nextProvider, cliSessionId: nextCliSessionId } : {}),
        ...(input.model !== undefined ? { model: nextModel } : {}),
        updatedAt: now,
      })
      .where(eq(sessions.id, row.id))
      .run();

    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: row.id });
    return this.getSession(projectId, row.id);
  }

  deleteSession(projectId: string, sessionId: string): void {
    const project = this.getProjectRow(projectId);
    const row = this.getSessionRow(projectId, sessionId);
    this.db.delete(sessions).where(eq(sessions.id, row.id)).run();

    // Remove session artifacts under `.dalang/sessions/<sessionId>/` safely without touching merged code.
    const sessionDir = getSessionDir(project.path, row.id);
    try {
      if (fs.existsSync(sessionDir) && !fs.lstatSync(sessionDir).isSymbolicLink()) {
        const realProject = fs.realpathSync(project.path);
        const realSession = fs.realpathSync(sessionDir);
        if (realSession.startsWith(`${realProject}${path.sep}`)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    } catch {
      // Ignore cleanup errors if directory is already gone.
    }

    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: row.id });
  }

  switchSessionMode(
    projectId: string,
    sessionId: string,
    targetMode: SessionMode,
  ): SessionSummaryDTO {
    const row = this.getSessionRow(projectId, sessionId);
    const currentMode = (row.mode as SessionMode) || 'ask';
    if (currentMode === targetMode) {
      return this.toSessionSummary(row);
    }

    if (MODE_RANK[targetMode] < MODE_RANK[currentMode]) {
      if (row.workState === 'working') {
        throw conflictError(
          `Cannot switch a working session back to ${targetMode}: unfinished work has modified files. Merge or discard the work first.`,
        );
      }
      throw conflictError(
        `Session mode can only move upward (Ask -> Quick -> Full).`,
      );
    }

    const now = new Date().toISOString();
    // Promoting Quick -> Full clears any unrun draft Quick plan so Full starts cleanly in Discuss
    // while keeping the Quick request and Lead findings in the conversation.
    if (currentMode === 'quick' && targetMode === 'full') {
      const draftQuickPlans = this.db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.sessionId, row.id),
            eq(plans.status, 'draft'),
            isNull(plans.briefId),
          ),
        )
        .all();
      for (const draftPlan of draftQuickPlans) {
        const planTasks = this.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.planId, draftPlan.id))
          .all();
        const taskIds = planTasks.map((t) => t.id);
        const hasRuns =
          taskIds.length > 0 &&
          this.db.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, taskIds)).all().length > 0;
        if (!hasRuns) {
          this.db.delete(plans).where(eq(plans.id, draftPlan.id)).run();
        }
      }
    }

    this.db
      .update(sessions)
      .set({
        mode: targetMode,
        ...(targetMode === 'full' ? { phase: 'discuss' } : {}),
        updatedAt: now,
      })
      .where(eq(sessions.id, row.id))
      .run();

    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: row.id });
    this.events?.emitEvent({ type: 'discuss.updated', projectId, sessionId: row.id });
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: row.id });
    return this.getSession(projectId, row.id);
  }

  hasSessionUnfinishedWork(sessionId: string): boolean {
    const sessionPlans = this.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .all();
    if (sessionPlans.length === 0) return false;
    const taskRows = this.db
      .select({
        status: tasks.status,
        branchName: tasks.branchName,
        delegationDepth: tasks.delegationDepth,
      })
      .from(tasks)
      .where(inArray(tasks.planId, sessionPlans.map((p) => p.id)))
      .all();
    return taskRows.some((t) => {
      if ((t.delegationDepth ?? 0) > 0) {
        return t.status === 'running' || t.status === 'reviewing';
      }
      return (
        UNFINISHED_TASK_STATUSES.has(t.status) ||
        (Boolean(t.branchName && t.branchName.trim()) && t.status !== 'done')
      );
    });
  }

  hasSessionCompletedWork(sessionId: string): boolean {
    const sessionPlans = this.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .all();
    if (sessionPlans.length === 0) return false;
    const taskRows = this.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.planId, sessionPlans.map((p) => p.id)))
      .all();
    if (taskRows.length === 0) return false;
    return taskRows.some((t) => t.status === 'done') && !this.hasSessionUnfinishedWork(sessionId);
  }

  assertCanStartWorkInSession(projectId: string, sessionId: string): void {
    const other = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), eq(sessions.workState, 'working')))
      .get();
    if (other && other.id !== sessionId) {
      const name = other.title?.trim() || 'Untitled session';
      throw conflictError(
        `Cannot start work while session "${name}" has unfinished work. Merge or discard its work first.`,
      );
    }
  }

  markSessionWorking(projectId: string, sessionId: string): void {
    this.assertCanStartWorkInSession(projectId, sessionId);
    const now = new Date().toISOString();
    try {
      this.db
        .update(sessions)
        .set({ workState: 'working', updatedAt: now })
        .where(and(eq(sessions.id, sessionId), eq(sessions.projectId, projectId)))
        .run();
    } catch (err) {
      // Partial unique index guards concurrent starts.
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(msg)) {
        this.assertCanStartWorkInSession(projectId, sessionId);
      }
      throw err;
    }
    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId });
  }

  reconcileSessionWorkState(sessionId: string, hasActiveExecution = false): SessionWorkState {
    const row = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) return 'idle';
    const nextState: SessionWorkState =
      hasActiveExecution || this.hasSessionUnfinishedWork(sessionId) ? 'working' : 'idle';
    if (row.workState !== nextState) {
      this.db
        .update(sessions)
        .set({ workState: nextState, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .run();
      this.events?.emitEvent({
        type: 'sessions.updated',
        projectId: row.projectId,
        sessionId: row.id,
      });
    }
    return nextState;
  }

  resolveSessionIdForRead(projectId: string, explicitSessionId?: string): string | null {
    this.getProjectRow(projectId);
    if (explicitSessionId) {
      return this.getSessionRow(projectId, explicitSessionId).id;
    }
    const working = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), eq(sessions.workState, 'working')))
      .get();
    if (working) return working.id;

    const latest = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), isNull(sessions.archivedAt)))
      .orderBy(desc(sessions.updatedAt))
      .get();
    if (latest) return latest.id;

    const anySession = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .orderBy(desc(sessions.updatedAt))
      .get();
    return anySession?.id ?? null;
  }

  resolveSessionIdForTask(
    projectId: string,
    taskIdOrExternalId: string,
    explicitSessionId?: string,
  ): string | null {
    this.getProjectRow(projectId);
    // Exact UUID match first.
    const byId = this.db
      .select({ planId: tasks.planId })
      .from(tasks)
      .where(eq(tasks.id, taskIdOrExternalId))
      .get();
    if (byId) {
      const plan = this.db.select().from(plans).where(eq(plans.id, byId.planId)).get();
      if (plan && plan.projectId === projectId) {
        return plan.sessionId ?? this.resolveSessionIdForRead(projectId, explicitSessionId);
      }
    }

    // Fallback: resolve by sessionId then externalId.
    const resolvedSid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (resolvedSid) {
      const sessionPlan = this.getPlan(projectId, resolvedSid);
      if (sessionPlan?.tasks.some((t) => t.id === taskIdOrExternalId || t.externalId === taskIdOrExternalId)) {
        return resolvedSid;
      }
    }

    // Search most recent plan containing externalId.
    const projectPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.projectId, projectId))
      .orderBy(desc(plans.createdAt))
      .all();
    for (const p of projectPlans) {
      const hit = this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.planId, p.id), eq(tasks.externalId, taskIdOrExternalId)))
        .get();
      if (hit && p.sessionId) return p.sessionId;
    }

    return resolvedSid;
  }

  getSessionDetail(projectId: string, sessionId: string): SessionDetailDTO {
    const session = this.getSession(projectId, sessionId);
    const discuss = this.getDiscussState(projectId, sessionId);
    const sessionBriefs = this.listBriefs(projectId, sessionId);
    const plan = this.getPlan(projectId, sessionId);
    return {
      session,
      messages: discuss.messages,
      currentRound: discuss.currentRound,
      briefs: sessionBriefs,
      plan,
    };
  }

  // ---------------------------------------------------------------------------
  // Unified chat entry point (Ask / Quick / Full)
  // ---------------------------------------------------------------------------

  sendChatMessage(projectId: string, input: ChatMessageInput): Promise<ChatTurnResult> {
    return this.exclusiveTurn(projectId, () => this.sendChatMessageInner(projectId, input));
  }

  private async sendChatMessageInner(
    projectId: string,
    input: ChatMessageInput,
  ): Promise<ChatTurnResult> {
    const project = this.getProjectRow(projectId);
    const requestedMode: SessionMode = input.mode ?? 'ask';
    const images = decodeChatImages(input.images ?? []);
    const existingSession = input.sessionId ? this.getSessionRow(projectId, input.sessionId) : null;
    if (images.length && (input.provider ?? existingSession?.provider ?? project.leadProvider) === 'antigravity') {
      throw new Error('Choose Claude Code or Codex to send images.');
    }
    const title = deriveSessionTitle(input.message, images[0]?.name);

    let sessionRow: typeof sessions.$inferSelect;
    if (!input.sessionId) {
      if (requestedMode === 'quick') {
        this.assertCanStartWorkInSession(projectId, '');
      }
      const created = this.createSession(projectId, {
        mode: requestedMode,
        title,
        provider: input.provider,
        model: input.model,
      });
      sessionRow = this.getSessionRow(projectId, created.id);
    } else {
      sessionRow = existingSession!;
      const currentMode = (sessionRow.mode as SessionMode) || 'ask';

      // Sync optional provider/model override on the session.
      const nextProvider = input.provider ?? (sessionRow.provider as ProviderId);
      const nextModel =
        input.model !== undefined ? (input.model?.trim() || null) : sessionRow.model;
      if (nextProvider !== sessionRow.provider || nextModel !== sessionRow.model) {
        const nextCliId = nextProvider === sessionRow.provider ? sessionRow.cliSessionId : null;
        this.db
          .update(sessions)
          .set({
            provider: nextProvider,
            model: nextModel,
            cliSessionId: nextCliId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(sessions.id, sessionRow.id))
          .run();
        sessionRow = this.getSessionRow(projectId, sessionRow.id);
      }

      if (MODE_RANK[requestedMode] > MODE_RANK[currentMode]) {
        if (requestedMode === 'quick') {
          this.assertCanStartWorkInSession(projectId, sessionRow.id);
        }
        this.switchSessionMode(projectId, sessionRow.id, requestedMode);
        sessionRow = this.getSessionRow(projectId, sessionRow.id);
      } else if (requestedMode === 'ask') {
        // A question is read-only, so it can be asked in any session, at any time, without changing its mode.
      } else if (MODE_RANK[requestedMode] < MODE_RANK[currentMode]) {
        if (sessionRow.workState === 'working') {
          throw conflictError(
            `Cannot switch a working session back to ${requestedMode}: unfinished work has modified files. Merge or discard the work first.`,
          );
        }
        // A finished (idle, completed) Quick or Full session reopens as a chat:
        // Ask-style follow-up questions (or starting a new Quick cycle) are allowed without demoting mode.
        const isFinishedSession = this.hasSessionCompletedWork(sessionRow.id);
        if (!isFinishedSession) {
          throw conflictError(
            `Session mode can only move upward (Ask -> Quick -> Full).`,
          );
        }
        if (requestedMode === 'quick') {
          this.assertCanStartWorkInSession(projectId, sessionRow.id);
        }
      } else if (requestedMode === 'quick') {
        this.assertCanStartWorkInSession(projectId, sessionRow.id);
      }

      if (!sessionRow.title?.trim()) {
        this.db
          .update(sessions)
          .set({
            title,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(sessions.id, sessionRow.id))
          .run();
        sessionRow = this.getSessionRow(projectId, sessionRow.id);
      }
    }

    if (requestedMode === 'ask') {
      const askReply = await this.runAskTurnInner(project, sessionRow, input.message, input.effort, images);
      return {
        session: this.getSession(projectId, sessionRow.id),
        mode: 'ask',
        askReply,
        messages: this.getDiscussState(projectId, sessionRow.id).messages,
      };
    }

    if (requestedMode === 'quick') {
      const { quickPlan, plan } = await this.runQuickTurnInner(
        project,
        sessionRow,
        input.message,
        input.effort,
        images,
      );
      return {
        session: this.getSession(projectId, sessionRow.id),
        mode: 'quick',
        quickPlan,
        plan,
        messages: this.getDiscussState(projectId, sessionRow.id).messages,
      };
    }

    // Full mode: Discuss round
    const discussRes = await this.sendDiscussMessageInner(projectId, {
      sessionId: sessionRow.id,
      message: input.message,
      answers: input.answers,
      provider: input.provider,
      model: input.model ?? undefined,
      effort: input.effort,
    }, images);
    return {
      session: this.getSession(projectId, sessionRow.id),
      mode: 'full',
      round: discussRes.round,
      messages: discussRes.messages,
    };
  }

  private async runAskTurnInner(
    project: typeof projects.$inferSelect,
    sessionRow: typeof sessions.$inferSelect,
    rawMessage: string,
    effort: EffortLevel = 'medium',
    images: ChatTurnImage[] = [],
  ): Promise<AskMessageContent> {
    const userText = rawMessage.trim();
    const priorMessages = this.getDiscussState(project.id, sessionRow.id).messages;
    this.appendUserMessage(sessionRow.id, userText, images);
    this.touchSession(sessionRow.id);
    this.events?.emitEvent({ type: 'discuss.updated', projectId: project.id, sessionId: sessionRow.id });
    this.events?.emitEvent({ type: 'sessions.updated', projectId: project.id, sessionId: sessionRow.id });

    // Write Ask CLI logs inside `.dalang/tmp/` (always gitignored in v0.1..v0.7 repos) so `git status` stays clean.
    const tmpDir = getProjectTmpDir(project.path);
    ensureProjectDir(project.path, tmpDir);
    const logFilePath = path.join(tmpDir, `ask-${sessionRow.id}-${Date.now()}.log`);

    const projectMdPath = path.join(project.path, 'PROJECT.md');
    const projectContext = fs.existsSync(projectMdPath)
      ? readArtifactFile(project.path, projectMdPath)
      : '';

    const completedWorkSummary = this.buildCompletedWorkContext(sessionRow.id);
    const buildPrompt = (includeHistory: boolean) => {
      const historyBlock =
        includeHistory && priorMessages.length > 0
          ? `\nPrevious conversation in this session:\n${this.formatTranscript(priorMessages)}\n`
          : '';
      return [
        `You are the Lead architect in DALANG's Ask mode (read-only Q&A about this repository).`,
        buildLanguageInstruction(this.getLanguage()),
        `STRICT RULE: You are in READ-ONLY mode. Do NOT create, modify, or delete any files and do NOT run mutating commands.`,
        `Project: ${project.name} (${project.path})`,
        projectContext ? `\nCurrent PROJECT.md:\n${projectContext}\n` : '',
        completedWorkSummary ? `\n${completedWorkSummary}\n` : '',
        historyBlock,
        `User question:\n${userText || 'See the attached images.'}`,
        ``,
        `Response instructions:`,
        `- Answer clearly and directly based on the repository and conversation context.`,
        `- If the user is asking for a code change, do NOT make the edit; explain what would be needed and optionally suggest switching to "quick" (for a small single-task fix/feature) or "full" (for a larger multi-task feature).`,
        `- You may reply with a JSON object matching {"answer": string, "suggested_mode": "quick" | "full" | null, "suggestion_reason": string | null}, or plain text if no mode switch is needed.`,
      ]
        .filter(Boolean)
        .join('\n');
    };

    const adapter = this.registry.getAdapter(sessionRow.provider as ProviderId);
    const startedAt = new Date().toISOString();
    const relLogPath = path.relative(project.path, logFilePath);
    let totalUsage: TurnTokenUsage | undefined;
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId: project.id,
      sessionId: sessionRow.id,
      phase: 'ask',
      provider: sessionRow.provider,
    });

    try {
      const shouldInlineHistory = !sessionRow.cliSessionId;
      let turn = await adapter.runTurn({
        projectPath: project.path,
        prompt: buildPrompt(shouldInlineHistory),
        images,
        sessionId: sessionRow.cliSessionId,
        model: sessionRow.model,
        effort,
        permissionMode: 'read-only',
        logFilePath,
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId: project.id,
            sessionId: sessionRow.id,
            phase: 'ask',
            line,
          }),
      });
      totalUsage = mergeTokenUsage(totalUsage, turn.usage);

      // If resuming a saved CLI session failed, transparently retry once with saved message context.
      if (sessionRow.cliSessionId && (turn.exitCode !== 0 || !turn.text.trim())) {
        turn = await adapter.runTurn({
          projectPath: project.path,
          prompt: buildPrompt(true),
          images,
          sessionId: null,
          model: sessionRow.model,
          effort,
          permissionMode: 'read-only',
          logFilePath,
          onLogLine: (line) =>
            this.events?.emitEvent({
              type: 'lead.log',
              projectId: project.id,
              sessionId: sessionRow.id,
              phase: 'ask',
              line,
            }),
        });
        totalUsage = mergeTokenUsage(totalUsage, turn.usage);
      }

      if (turn.exitCode !== 0 && !turn.text.trim()) {
        throw new Error(
          `Ask turn failed (exit ${turn.exitCode ?? 'unknown'}): ${(turn.stderr || 'No response').slice(0, 240)}`,
        );
      }

      const parsedReply = this.parseAskReply(turn);
      const nextCliSessionId = turn.sessionId ?? sessionRow.cliSessionId;

      this.db
        .update(sessions)
        .set({
          cliSessionId: nextCliSessionId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, sessionRow.id))
        .run();

      this.recordLeadTurn({
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'ask',
        provider: sessionRow.provider as ProviderId,
        model: sessionRow.model,
        status: 'completed',
        cliSessionId: nextCliSessionId,
        startedAt,
        logPath: relLogPath,
        usage: totalUsage,
      });

      this.appendMessage(sessionRow.id, 'lead', 'ask', parsedReply);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'ask',
        ok: true,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId: project.id, sessionId: sessionRow.id });
      this.events?.emitEvent({ type: 'sessions.updated', projectId: project.id, sessionId: sessionRow.id });

      return parsedReply;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordLeadTurn({
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'ask',
        provider: sessionRow.provider as ProviderId,
        model: sessionRow.model,
        status: 'failed',
        cliSessionId: sessionRow.cliSessionId,
        startedAt,
        failureReason: msg,
        logPath: relLogPath,
        usage: totalUsage,
      });
      this.appendMessage(sessionRow.id, 'system', 'error', msg);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'ask',
        ok: false,
        error: msg,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId: project.id, sessionId: sessionRow.id });
      throw err;
    }
  }

  private parseAskReply(turn: { text: string; structuredOutput?: unknown; stdout: string; stderr: string; exitCode: number | null; sessionId: string | null }): AskMessageContent {
    const candidate = extractJsonCandidate(turn);
    if (candidate && typeof candidate === 'object') {
      const parsed = AskReplyContractSchema.safeParse(candidate);
      if (parsed.success) {
        const suggestion: ModeSuggestion | null =
          parsed.data.suggested_mode && parsed.data.suggestion_reason?.trim()
            ? {
                targetMode: parsed.data.suggested_mode,
                reason: parsed.data.suggestion_reason.trim(),
              }
            : parsed.data.suggested_mode
              ? {
                  targetMode: parsed.data.suggested_mode,
                  reason:
                    parsed.data.suggested_mode === 'quick'
                      ? 'This looks like a small focused change.'
                      : 'This work spans multiple steps and benefits from a brief and plan.',
                }
              : null;
        return {
          text: parsed.data.answer.trim(),
          suggestion,
        };
      }
    }
    return {
      text: turn.text.trim() || '(no response)',
      suggestion: null,
    };
  }

  private async runQuickTurnInner(
    project: typeof projects.$inferSelect,
    sessionRow: typeof sessions.$inferSelect,
    rawMessage: string,
    effort: EffortLevel = 'high',
    images: ChatTurnImage[] = [],
  ): Promise<{ quickPlan: QuickPlanContract; plan: PlanDTO | null }> {
    const userText = rawMessage.trim();
    const priorMessages = this.getDiscussState(project.id, sessionRow.id).messages;
    this.appendUserMessage(sessionRow.id, userText, images);
    this.touchSession(sessionRow.id);
    this.events?.emitEvent({ type: 'discuss.updated', projectId: project.id, sessionId: sessionRow.id });
    this.events?.emitEvent({ type: 'sessions.updated', projectId: project.id, sessionId: sessionRow.id });

    const existingPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.sessionId, sessionRow.id))
      .orderBy(desc(plans.version))
      .all();
    const nextPlanVersion = existingPlans.length > 0 ? existingPlans[0].version + 1 : 1;

    const sessionDir = getSessionDir(project.path, sessionRow.id);
    const tmpDir = getSessionTmpDir(project.path, sessionRow.id);
    const logsDir = getSessionLogsDir(project.path, sessionRow.id);
    ensureProjectDir(project.path, sessionDir);
    ensureProjectDir(project.path, tmpDir);
    ensureProjectDir(project.path, logsDir);

    const draftFilePath = path.join(tmpDir, `quick-plan-v${nextPlanVersion}.json`);
    const relDraftPath = path.relative(project.path, draftFilePath).split(path.sep).join('/');

    const projectMdPath = path.join(project.path, 'PROJECT.md');
    const projectContext = fs.existsSync(projectMdPath)
      ? readArtifactFile(project.path, projectMdPath)
      : '';
    const completedWorkSummary = this.buildCompletedWorkContext(sessionRow.id);
    const transcriptBlock =
      priorMessages.length > 0
        ? `\nPrior conversation in this session:\n${this.formatTranscript(priorMessages)}\n`
        : '';

    const prompt = [
      `You are the Lead architect in DALANG's Quick mode (single-task mini plan for a bug fix or small feature, with NO brief).`,
      buildLanguageInstruction(this.getLanguage()),
      `Project: ${project.name} (${project.path})`,
      projectContext ? `\nCurrent PROJECT.md:\n${projectContext}\n` : '',
      completedWorkSummary ? `\n${completedWorkSummary}\n` : '',
      transcriptBlock,
      `User request:\n${userText || 'See the attached images.'}`,
      ``,
      `Instructions:`,
      `- Inspect the codebase to understand the exact files involved.`,
      `- If this request can be completed safely in ONE focused task (narrow files_allowed, concrete acceptance criteria, exact verify command), set "verdict": "ready" and fill "task" (with id "T-001", milestone "Quick", role "engineer", complexity "low" or "medium", depends_on [], needs_split false).`,
      `- If this request genuinely needs more than one task, touches many unrelated areas, or has major open design decisions, set "verdict": "too_large", omit "task", explain why in "reason", and list key observations in "findings".`,
      `- The verify command runs inside the task worktree. Use paths relative to the project root; never cd into or reference the project's absolute path.`,
      `- Do NOT edit application source files yourself. Write ONLY the JSON contract to "${relDraftPath}".`,
      `- Schema: ${JSON.stringify(z.toJSONSchema(QuickPlanContractSchema))}`,
    ]
      .filter(Boolean)
      .join('\n');

    const adapter = this.registry.getAdapter(sessionRow.provider as ProviderId);
    const startedAt = new Date().toISOString();
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId: project.id,
      sessionId: sessionRow.id,
      phase: 'quick',
      provider: sessionRow.provider,
    });

    try {
      const result = await this.runContractWithResumeFallback({
        adapter,
        projectPath: project.path,
        sessionId: sessionRow.cliSessionId,
        model: sessionRow.model,
        effort,
        prompt,
        images,
        targetFilePath: draftFilePath,
        schema: QuickPlanContractSchema,
        schemaName: `quick-plan-v${nextPlanVersion}`,
        logsDir,
        tmpDir,
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId: project.id,
            sessionId: sessionRow.id,
            phase: 'quick',
            line,
          }),
      });

      this.recordLeadTurn({
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'quick',
        provider: sessionRow.provider as ProviderId,
        model: sessionRow.model,
        status: 'completed',
        cliSessionId: result.sessionId,
        startedAt,
        logPath: path.relative(project.path, result.logFilePath),
        usage: result.usage,
      });

      const quickData = result.data;
      let createdPlan: PlanDTO | null = null;

      if (quickData.verdict === 'ready' && quickData.task) {
        const planFilePath = path.join(sessionDir, 'plan.json');
        const relPlanPath = path.relative(project.path, planFilePath).split(path.sep).join('/');

        const normalizedTask: PlanTaskContract = {
          ...quickData.task,
          id: quickData.task.id || 'T-001',
          milestone: quickData.task.milestone || 'Quick',
          depends_on: [],
          needs_split: false,
        };
        const planContract: PlanContract = PlanContractSchema.parse({
          version: nextPlanVersion,
          brief_version: 1,
          milestones: [{ id: normalizedTask.milestone, title: normalizedTask.milestone, description: quickData.summary }],
          tasks: [normalizedTask],
        });
        writeArtifactFile(project.path, planFilePath, JSON.stringify(planContract, null, 2));

        const planId = crypto.randomUUID();
        const now = new Date().toISOString();
        this.db
          .insert(plans)
          .values({
            id: planId,
            projectId: project.id,
            sessionId: sessionRow.id,
            briefId: null,
            version: nextPlanVersion,
            status: 'draft',
            filePath: relPlanPath,
            createdAt: now,
            approvedAt: null,
          })
          .run();

        this.persistPlanTasks(planId, [
          { task: normalizedTask, splitDepth: 0, parentExternalId: null },
        ]);
        this.syncPlanJsonFile(project.id, planId, sessionRow.id);

        this.db
          .update(sessions)
          .set({
            cliSessionId: result.sessionId,
            phase: 'list',
            updatedAt: now,
          })
          .where(eq(sessions.id, sessionRow.id))
          .run();

        createdPlan = this.getPlan(project.id, sessionRow.id);
        const createdTask = createdPlan?.tasks[0];

        const msgPayload: QuickPlanMessageContent = {
          verdict: 'ready',
          summary: quickData.summary,
          planId,
          planVersion: nextPlanVersion,
          task: normalizedTask,
          taskId: createdTask?.id,
        };
        this.appendMessage(sessionRow.id, 'lead', 'quick_plan', msgPayload);
      } else {
        this.db
          .update(sessions)
          .set({
            cliSessionId: result.sessionId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(sessions.id, sessionRow.id))
          .run();

        const msgPayload: QuickPlanMessageContent = {
          verdict: 'too_large',
          summary: quickData.summary,
          reason: quickData.reason ?? quickData.summary,
          findings: quickData.findings,
        };
        this.appendMessage(sessionRow.id, 'lead', 'quick_plan', msgPayload);
      }

      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'quick',
        ok: true,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId: project.id, sessionId: sessionRow.id });
      this.events?.emitEvent({ type: 'plan.updated', projectId: project.id, sessionId: sessionRow.id });
      this.events?.emitEvent({ type: 'sessions.updated', projectId: project.id, sessionId: sessionRow.id });

      return { quickPlan: quickData, plan: createdPlan };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMeta = err as { usage?: TurnTokenUsage; logFilePath?: string };
      this.recordLeadTurn({
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'quick',
        provider: sessionRow.provider as ProviderId,
        model: sessionRow.model,
        status: 'failed',
        cliSessionId: sessionRow.cliSessionId,
        startedAt,
        failureReason: msg,
        logPath: errMeta?.logFilePath ? path.relative(project.path, errMeta.logFilePath) : null,
        usage: errMeta?.usage,
      });
      this.appendMessage(sessionRow.id, 'system', 'error', msg);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId: project.id,
        sessionId: sessionRow.id,
        phase: 'quick',
        ok: false,
        error: msg,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId: project.id, sessionId: sessionRow.id });
      throw err;
    }
  }

  approveQuickPlan(projectId: string, sessionId: string): PlanDTO {
    const row = this.getSessionRow(projectId, sessionId);
    this.assertCanStartWorkInSession(projectId, row.id);
    const plan = this.getPlan(projectId, row.id);
    if (!plan) {
      throw new Error('No Quick mini-plan exists in this session yet.');
    }
    const approved = this.approvePlan(projectId, row.id);
    this.db
      .update(sessions)
      .set({ phase: 'run', updatedAt: new Date().toISOString() })
      .where(eq(sessions.id, row.id))
      .run();
    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: row.id });
    return approved;
  }

  // ---------------------------------------------------------------------------
  // Full mode (Discuss -> Brief -> Plan) — session-scoped with backward compat
  // ---------------------------------------------------------------------------

  sendDiscussMessage(
    projectId: string,
    input: DiscussMessageInput,
  ): Promise<{ round: DiscussRound; messages: DiscussMessageDTO[]; sessionId?: string }> {
    return this.exclusiveTurn(projectId, () => this.sendDiscussMessageInner(projectId, input));
  }

  finishDiscussAndWriteBrief(projectId: string, sessionId?: string): Promise<BriefDTO> {
    return this.exclusiveTurn(projectId, () =>
      this.finishDiscussAndWriteBriefInner(projectId, sessionId),
    );
  }

  reviseBrief(
    projectId: string,
    version: number,
    note: string,
    sessionId?: string,
  ): Promise<BriefDTO> {
    return this.exclusiveTurn(projectId, () =>
      this.reviseBriefInner(projectId, version, note, sessionId),
    );
  }

  generatePlan(projectId: string, sessionId?: string): Promise<PlanDTO> {
    return this.exclusiveTurn(projectId, () => this.generatePlanInner(projectId, sessionId));
  }

  private getProjectRow(projectId: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return row;
  }

  private getOrCreateLeadSession(
    projectId: string,
    explicitSessionId?: string,
    overrideProvider?: ProviderId,
    overrideModel?: string,
  ) {
    const project = this.getProjectRow(projectId);
    const provider = overrideProvider ?? (project.leadProvider as ProviderId);
    const model = overrideModel !== undefined ? overrideModel : project.leadModel;

    const existing = explicitSessionId
      ? this.getSessionRow(projectId, explicitSessionId)
      : this.db
          .select()
          .from(sessions)
          .where(and(eq(sessions.projectId, projectId), isNull(sessions.archivedAt)))
          .orderBy(desc(sessions.updatedAt))
          .get();

    const now = new Date().toISOString();
    if (existing) {
      const nextMode = existing.mode === 'ask' && !explicitSessionId ? 'full' : existing.mode;
      // If user switched provider, clear cliSessionId since session IDs are provider-specific.
      if (
        existing.provider !== provider ||
        (model !== undefined && existing.model !== (model || null)) ||
        nextMode !== existing.mode
      ) {
        const nextCliId = existing.provider === provider ? existing.cliSessionId : null;
        this.db
          .update(sessions)
          .set({
            mode: nextMode,
            provider,
            model: model || null,
            cliSessionId: nextCliId,
            updatedAt: now,
          })
          .where(eq(sessions.id, existing.id))
          .run();
        return this.db.select().from(sessions).where(eq(sessions.id, existing.id)).get()!;
      }
      return existing;
    }

    const id = crypto.randomUUID();
    this.db
      .insert(sessions)
      .values({
        id,
        projectId,
        title: '',
        mode: 'full',
        workState: 'idle',
        phase: 'discuss',
        provider,
        model: model || null,
        cliSessionId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: id });
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get()!;
  }

  private touchSession(sessionId: string): void {
    this.db
      .update(sessions)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  private appendMessage(
    sessionId: string,
    role: 'user' | 'lead' | 'system',
    type: SessionMessageType,
    content: unknown,
  ): DiscussMessageDTO {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    this.db
      .insert(messages)
      .values({
        id,
        sessionId,
        role,
        type,
        content: serialized,
        createdAt,
      })
      .run();

    return {
      id,
      sessionId,
      role,
      type,
      content,
      createdAt,
    };
  }

  private appendUserMessage(sessionId: string, text: string, images: ChatTurnImage[]): void {
    if (!images.length) {
      this.appendMessage(sessionId, 'user', 'text', text);
      return;
    }
    const attachments = images.map((image) => ({ ...image, id: crypto.randomUUID() }));
    const content: ChatImageMessage = {
      text,
      images: attachments.map(({ id, name }) => ({ id, name })),
    };
    this.db.transaction(() => {
      const message = this.appendMessage(sessionId, 'user', 'images', content);
      this.db.insert(messageImages).values(attachments.map(({ id, mimeType, data }) => ({
        id, messageId: message.id, mimeType, data,
      }))).run();
    });
  }

  getChatImage(id: string): typeof messageImages.$inferSelect | undefined {
    return this.db.select().from(messageImages).where(eq(messageImages.id, id)).get();
  }

  getDiscussState(
    projectId: string,
    explicitSessionId?: string,
  ): {
    session: {
      id: string;
      title: string;
      mode: SessionMode;
      workState: SessionWorkState;
      phase: SessionPhase;
      provider: ProviderId;
      model: string | null;
      cliSessionId: string | null;
    } | null;
    messages: DiscussMessageDTO[];
    currentRound: number;
  } {
    this.getProjectRow(projectId);
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (!sid) {
      return { session: null, messages: [], currentRound: 0 };
    }
    const session = this.db.select().from(sessions).where(eq(sessions.id, sid)).get();
    if (!session) {
      return { session: null, messages: [], currentRound: 0 };
    }

    const msgRows = this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, session.id))
      .orderBy(asc(messages.createdAt))
      .all();

    let maxRound = 0;
    const formatted: DiscussMessageDTO[] = msgRows.map((row) => {
      let parsedContent: unknown = row.content;
      if (row.type !== 'text' && row.type !== 'error') {
        try {
          parsedContent = JSON.parse(row.content);
          if (row.type === 'questions' && parsedContent && typeof parsedContent === 'object') {
            const r = (parsedContent as { round?: number }).round;
            if (typeof r === 'number' && r > maxRound) maxRound = r;
          }
        } catch {
          parsedContent = row.content;
        }
      }
      return {
        id: row.id,
        sessionId: row.sessionId,
        role: row.role as 'user' | 'lead' | 'system',
        type: row.type as SessionMessageType,
        content: parsedContent,
        createdAt: row.createdAt,
      };
    });

    return {
      session: {
        id: session.id,
        title: session.title,
        mode: (session.mode as SessionMode) || 'ask',
        workState: (session.workState as SessionWorkState) || 'idle',
        phase: (session.phase as SessionPhase) || 'discuss',
        provider: session.provider as ProviderId,
        model: session.model,
        cliSessionId: session.cliSessionId,
      },
      messages: formatted,
      currentRound: maxRound,
    };
  }

  private async sendDiscussMessageInner(
    projectId: string,
    input: DiscussMessageInput,
    images: ChatTurnImage[] = [],
  ): Promise<{ round: DiscussRound; messages: DiscussMessageDTO[]; sessionId: string }> {
    const project = this.getProjectRow(projectId);
    const session = this.getOrCreateLeadSession(
      projectId,
      input.sessionId,
      input.provider,
      input.model,
    );
    // Ensure session mode is promoted to `full` when running Discuss.
    if (session.mode !== 'full') {
      this.switchSessionMode(projectId, session.id, 'full');
    }

    const state = this.getDiscussState(projectId, session.id);
    const nextRound = state.currentRound + 1;
    const priorMessages = state.messages;

    const userText = this.formatUserDiscussMessage(input);
    this.appendUserMessage(session.id, userText, images);
    if (!session.title?.trim()) {
      this.db
        .update(sessions)
        .set({ title: deriveSessionTitle(input.message), updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, session.id))
        .run();
    } else {
      this.touchSession(session.id);
    }
    this.events?.emitEvent({ type: 'discuss.updated', projectId, sessionId: session.id });
    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: session.id });

    const discussDir = getSessionDiscussDir(project.path, session.id);
    const tmpDir = getSessionTmpDir(project.path, session.id);
    const logsDir = getSessionLogsDir(project.path, session.id);
    ensureProjectDir(project.path, discussDir);
    const roundFilePath = path.join(discussDir, `round-${nextRound}.json`);
    const relRoundPath = path.relative(project.path, roundFilePath).split(path.sep).join('/');

    const projectMdPath = path.join(project.path, 'PROJECT.md');
    const projectContext = fs.existsSync(projectMdPath)
      ? readArtifactFile(project.path, projectMdPath)
      : '';

    const priorContext =
      priorMessages.length > 0
        ? `\nPrevious conversation in this session:\n${this.formatTranscript(priorMessages)}\n`
        : '';

    const prompt = [
      `You are the Lead architect in DALANG's Discuss phase.`,
      buildLanguageInstruction(this.getLanguage()),
      `Project: ${project.name} (${project.path})`,
      projectContext ? `\nCurrent PROJECT.md:\n${projectContext}\n` : '',
      priorContext,
      `User input:\n${userText || 'See the attached images.'}`,
      ``,
      `Instructions:`,
      `- Ask focused, high-leverage clarification questions (2 to 5 questions) to pin down scope, stack, constraints, and edge cases.`,
      `- If the goal is already completely clear, set "ready_for_brief": true and "questions": [].`,
      `- Write your JSON response directly to the file "${relRoundPath}" with round = ${nextRound}.`,
      `- Schema: ${JSON.stringify(z.toJSONSchema(DiscussRoundSchema))}`,
    ]
      .filter(Boolean)
      .join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    const startedAt = new Date().toISOString();
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      sessionId: session.id,
      phase: 'discuss',
      provider: session.provider,
    });

    try {
      const result = await this.runContractWithResumeFallback({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: input.effort ?? 'high',
        prompt,
        images,
        targetFilePath: roundFilePath,
        schema: DiscussRoundSchema,
        schemaName: `discuss-round-${nextRound}`,
        logsDir,
        tmpDir,
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId,
            sessionId: session.id,
            phase: 'discuss',
            line,
          }),
      });

      this.db
        .update(sessions)
        .set({
          cliSessionId: result.sessionId,
          phase: 'discuss',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, session.id))
        .run();

      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'discuss',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'completed',
        cliSessionId: result.sessionId,
        startedAt,
        logPath: path.relative(project.path, result.logFilePath),
        usage: result.usage,
      });

      this.appendMessage(session.id, 'lead', 'questions', result.data);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'discuss',
        ok: true,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId, sessionId: session.id });
      this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: session.id });

      return {
        round: result.data,
        messages: this.getDiscussState(projectId, session.id).messages,
        sessionId: session.id,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMeta = err as { usage?: TurnTokenUsage; logFilePath?: string };
      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'discuss',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'failed',
        cliSessionId: session.cliSessionId,
        startedAt,
        failureReason: msg,
        logPath: errMeta?.logFilePath ? path.relative(project.path, errMeta.logFilePath) : null,
        usage: errMeta?.usage,
      });
      this.appendMessage(session.id, 'system', 'error', msg);
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'discuss',
        ok: false,
        error: msg,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId, sessionId: session.id });
      throw err;
    }
  }

  private async finishDiscussAndWriteBriefInner(
    projectId: string,
    explicitSessionId?: string,
  ): Promise<BriefDTO> {
    const project = this.getProjectRow(projectId);
    const session = this.getOrCreateLeadSession(projectId, explicitSessionId);
    if (session.mode !== 'full') {
      this.switchSessionMode(projectId, session.id, 'full');
    }

    const existingBriefs = this.listBriefs(projectId, session.id);
    const nextVersion = existingBriefs.length > 0 ? existingBriefs[0].version + 1 : 1;

    const sessionDir = getSessionDir(project.path, session.id);
    const tmpDir = getSessionTmpDir(project.path, session.id);
    const logsDir = getSessionLogsDir(project.path, session.id);
    ensureProjectDir(project.path, sessionDir);
    const briefFilePath = path.join(sessionDir, `brief.v${nextVersion}.json`);
    const relBriefPath = path.relative(project.path, briefFilePath).split(path.sep).join('/');

    const discussHistory = this.getDiscussState(projectId, session.id).messages;
    const transcriptSummary = this.formatTranscript(discussHistory);

    const prompt = [
      `The user has ended the Discuss Q&A ("enough, write the brief").`,
      buildLanguageInstruction(this.getLanguage()),
      `Synthesize everything discussed so far into a concrete, testable Project Brief.`,
      transcriptSummary ? `\nDiscussion transcript:\n${transcriptSummary}\n` : '',
      `Write the brief JSON directly to "${relBriefPath}" with version = ${nextVersion}.`,
      `Schema: ${JSON.stringify(z.toJSONSchema(BriefContentSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    const startedAt = new Date().toISOString();
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      sessionId: session.id,
      phase: 'agree',
      provider: session.provider,
    });

    try {
      const result = await this.runContractWithResumeFallback({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: briefFilePath,
        schema: BriefContentSchema,
        schemaName: `brief-v${nextVersion}`,
        logsDir,
        tmpDir,
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId,
            sessionId: session.id,
            phase: 'agree',
            line,
          }),
      });

      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'agree',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'completed',
        cliSessionId: result.sessionId,
        startedAt,
        logPath: path.relative(project.path, result.logFilePath),
        usage: result.usage,
      });

      const normalized: BriefContent = { ...result.data, version: nextVersion };
      writeArtifactFile(project.path, briefFilePath, JSON.stringify(normalized, null, 2));

      const nextTitle = session.title?.trim() ? session.title : deriveSessionTitle(normalized.title, project.name);
      this.db
        .update(sessions)
        .set({
          cliSessionId: result.sessionId,
          phase: 'agree',
          title: nextTitle,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, session.id))
        .run();

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db
        .insert(briefs)
        .values({
          id,
          projectId,
          sessionId: session.id,
          version: nextVersion,
          status: 'draft',
          filePath: relBriefPath,
          createdAt: now,
          approvedAt: null,
        })
        .run();

      this.appendMessage(session.id, 'lead', 'brief', {
        version: nextVersion,
        title: normalized.title,
      });

      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'agree',
        ok: true,
      });
      this.events?.emitEvent({
        type: 'brief.updated',
        projectId,
        sessionId: session.id,
        version: nextVersion,
      });
      this.events?.emitEvent({ type: 'discuss.updated', projectId, sessionId: session.id });
      this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: session.id });

      return this.getBriefByVersion(projectId, nextVersion, session.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMeta = err as { usage?: TurnTokenUsage; logFilePath?: string };
      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'agree',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'failed',
        cliSessionId: session.cliSessionId,
        startedAt,
        failureReason: msg,
        logPath: errMeta?.logFilePath ? path.relative(project.path, errMeta.logFilePath) : null,
        usage: errMeta?.usage,
      });
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'agree',
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  listBriefs(projectId: string, explicitSessionId?: string): BriefDTO[] {
    const project = this.getProjectRow(projectId);
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (!sid) return [];

    const rows = this.db
      .select()
      .from(briefs)
      .where(and(eq(briefs.projectId, projectId), eq(briefs.sessionId, sid)))
      .orderBy(desc(briefs.version))
      .all();

    return rows.map((row) => this.readBriefRow(project.path, row));
  }

  getBriefByVersion(projectId: string, version: number, explicitSessionId?: string): BriefDTO {
    const project = this.getProjectRow(projectId);
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (!sid) throw new Error(`Brief v${version} not found`);

    const row = this.db
      .select()
      .from(briefs)
      .where(
        and(
          eq(briefs.projectId, projectId),
          eq(briefs.sessionId, sid),
          eq(briefs.version, version),
        ),
      )
      .get();
    if (!row) throw new Error(`Brief v${version} not found`);
    return this.readBriefRow(project.path, row);
  }

  updateBrief(
    projectId: string,
    version: number,
    rawContent: unknown,
    explicitSessionId?: string,
  ): BriefDTO {
    const project = this.getProjectRow(projectId);
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (!sid) throw new Error(`Brief v${version} not found`);

    const row = this.db
      .select()
      .from(briefs)
      .where(
        and(
          eq(briefs.projectId, projectId),
          eq(briefs.sessionId, sid),
          eq(briefs.version, version),
        ),
      )
      .get();
    if (!row) throw new Error(`Brief v${version} not found`);
    if (row.status === 'approved') {
      throw new Error(`Brief v${version} is approved and locked. Create a revision instead.`);
    }

    const parsed = BriefContentSchema.parse(rawContent);
    const content: BriefContent = { ...parsed, version };
    const absPath = path.join(project.path, row.filePath);
    writeArtifactFile(project.path, absPath, JSON.stringify(content, null, 2));

    this.events?.emitEvent({ type: 'brief.updated', projectId, sessionId: sid, version });
    return this.readBriefRow(project.path, row);
  }

  private async reviseBriefInner(
    projectId: string,
    version: number,
    note: string,
    explicitSessionId?: string,
  ): Promise<BriefDTO> {
    const project = this.getProjectRow(projectId);
    const session = this.getOrCreateLeadSession(projectId, explicitSessionId);
    const prevBrief = this.getBriefByVersion(projectId, version, session.id);
    const existingBriefs = this.listBriefs(projectId, session.id);
    const nextVersion = existingBriefs[0].version + 1;

    const sessionDir = getSessionDir(project.path, session.id);
    const tmpDir = getSessionTmpDir(project.path, session.id);
    const logsDir = getSessionLogsDir(project.path, session.id);
    ensureProjectDir(project.path, sessionDir);
    const briefFilePath = path.join(sessionDir, `brief.v${nextVersion}.json`);
    const relBriefPath = path.relative(project.path, briefFilePath).split(path.sep).join('/');

    const prompt = [
      `Revise the project brief based on the user's feedback note.`,
      buildLanguageInstruction(this.getLanguage()),
      `Previous brief (v${version}):\n${JSON.stringify(prevBrief.content, null, 2)}`,
      `User revision note:\n${note}`,
      ``,
      `Write the updated brief JSON directly to "${relBriefPath}" with version = ${nextVersion}.`,
      `Schema: ${JSON.stringify(z.toJSONSchema(BriefContentSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    const startedAt = new Date().toISOString();
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      sessionId: session.id,
      phase: 'agree',
      provider: session.provider,
    });

    try {
      const result = await this.runContractWithResumeFallback({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: briefFilePath,
        schema: BriefContentSchema,
        schemaName: `brief-v${nextVersion}`,
        logsDir,
        tmpDir,
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId,
            sessionId: session.id,
            phase: 'agree',
            line,
          }),
      });

      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'agree',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'completed',
        cliSessionId: result.sessionId,
        startedAt,
        logPath: path.relative(project.path, result.logFilePath),
        usage: result.usage,
      });

      const normalized: BriefContent = { ...result.data, version: nextVersion };
      writeArtifactFile(project.path, briefFilePath, JSON.stringify(normalized, null, 2));

      this.db
        .update(sessions)
        .set({ cliSessionId: result.sessionId, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, session.id))
        .run();

      this.db
        .insert(briefs)
        .values({
          id: crypto.randomUUID(),
          projectId,
          sessionId: session.id,
          version: nextVersion,
          status: 'draft',
          filePath: relBriefPath,
          createdAt: new Date().toISOString(),
          approvedAt: null,
        })
        .run();

      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'agree',
        ok: true,
      });
      this.events?.emitEvent({
        type: 'brief.updated',
        projectId,
        sessionId: session.id,
        version: nextVersion,
      });
      this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: session.id });
      return this.getBriefByVersion(projectId, nextVersion, session.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMeta = err as { usage?: TurnTokenUsage; logFilePath?: string };
      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'agree',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'failed',
        cliSessionId: session.cliSessionId,
        startedAt,
        failureReason: msg,
        logPath: errMeta?.logFilePath ? path.relative(project.path, errMeta.logFilePath) : null,
        usage: errMeta?.usage,
      });
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'agree',
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  approveBrief(projectId: string, version: number, explicitSessionId?: string): BriefDTO {
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (!sid) throw new Error(`Brief v${version} not found`);

    const row = this.db
      .select()
      .from(briefs)
      .where(
        and(
          eq(briefs.projectId, projectId),
          eq(briefs.sessionId, sid),
          eq(briefs.version, version),
        ),
      )
      .get();
    if (!row) throw new Error(`Brief v${version} not found`);

    const now = new Date().toISOString();
    this.db
      .update(briefs)
      .set({ status: 'approved', approvedAt: row.approvedAt ?? now })
      .where(eq(briefs.id, row.id))
      .run();

    this.db
      .update(sessions)
      .set({ phase: 'agree', updatedAt: now })
      .where(eq(sessions.id, sid))
      .run();

    this.events?.emitEvent({ type: 'brief.updated', projectId, sessionId: sid, version });
    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: sid });
    return this.getBriefByVersion(projectId, version, sid);
  }

  private async generatePlanInner(
    projectId: string,
    explicitSessionId?: string,
  ): Promise<PlanDTO> {
    const project = this.getProjectRow(projectId);
    const session = this.getOrCreateLeadSession(projectId, explicitSessionId);
    const approvedBrief = this.db
      .select()
      .from(briefs)
      .where(
        and(
          eq(briefs.projectId, projectId),
          eq(briefs.sessionId, session.id),
          eq(briefs.status, 'approved'),
        ),
      )
      .orderBy(desc(briefs.version))
      .get();

    if (!approvedBrief) {
      throw new Error('Approve a brief first before generating a plan.');
    }

    const briefDto = this.readBriefRow(project.path, approvedBrief);
    const sessionDir = getSessionDir(project.path, session.id);
    const tmpDir = getSessionTmpDir(project.path, session.id);
    const logsDir = getSessionLogsDir(project.path, session.id);
    ensureProjectDir(project.path, sessionDir);
    ensureProjectDir(project.path, tmpDir);
    const planFilePath = path.join(sessionDir, 'plan.json');
    const relPlanPath = path.relative(project.path, planFilePath).split(path.sep).join('/');

    const existingPlans = this.db
      .select()
      .from(plans)
      .where(and(eq(plans.projectId, projectId), eq(plans.sessionId, session.id)))
      .orderBy(desc(plans.version))
      .all();
    // Only block regeneration if the latest approved plan was generated for this same brief version
    // and still has unfinished work (allows starting a new Full cycle after a finished one).
    if (
      existingPlans[0]?.status === 'approved' &&
      existingPlans[0]?.briefId === approvedBrief.id
    ) {
      throw new Error(
        `Plan v${existingPlans[0].version} is approved and locked. It cannot be regenerated.`,
      );
    }
    const nextPlanVersion = existingPlans.length > 0 ? existingPlans[0].version + 1 : 1;

    // The agent drafts into tmp so a failed run never clobbers the current plan.json.
    const draftFilePath = path.join(tmpDir, `plan-v${nextPlanVersion}.json`);
    const relDraftPath = path.relative(project.path, draftFilePath).split(path.sep).join('/');

    const prompt = [
      `Break the approved project brief into concrete milestones and small, verifiable tasks.`,
      buildLanguageInstruction(this.getLanguage()),
      `Approved Brief (v${briefDto.version}):\n${JSON.stringify(briefDto.content, null, 2)}`,
      ``,
      `Task design rules:`,
      `- Each task needs an id like "T-001", "T-002", a milestone id ("M1", "M2"...), role ("engineer" or "qa"), complexity ("low", "medium", "high"), depends_on (array of task ids), goal, files_allowed, files_reference, acceptance_criteria, verify (exact test/check command), and needs_split (boolean).`,
      `- Set needs_split: true if a task is still too large for one focused coding run.`,
      `- Verify commands run inside the task worktree. Use paths relative to the project root; never cd into or reference the project's absolute path.`,
      `- Write the plan JSON directly to "${relDraftPath}" with version = ${nextPlanVersion} and brief_version = ${briefDto.version}.`,
      `- Task ids must be unique, every milestone must exist in "milestones", and every depends_on id must be another task in the plan with no cycles.`,
      `- Schema: ${JSON.stringify(z.toJSONSchema(PlanContractSchema))}`,
    ].join('\n');

    const adapter = this.registry.getAdapter(session.provider as ProviderId);
    const startedAt = new Date().toISOString();
    let totalUsage: TurnTokenUsage | undefined;
    let lastLogFilePath: string | null = null;
    this.events?.emitEvent({
      type: 'lead.turn_started',
      projectId,
      sessionId: session.id,
      phase: 'list',
      provider: session.provider,
    });

    try {
      const result = await this.runContractWithResumeFallback({
        adapter,
        projectPath: project.path,
        sessionId: session.cliSessionId,
        model: session.model,
        effort: 'high',
        prompt,
        targetFilePath: draftFilePath,
        schema: PlanContractSchema,
        schemaName: `plan-v${nextPlanVersion}`,
        logsDir,
        tmpDir,
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId,
            sessionId: session.id,
            phase: 'list',
            line,
          }),
      });
      totalUsage = mergeTokenUsage(totalUsage, result.usage);
      lastLogFilePath = result.logFilePath;

      let currentSessionId = result.sessionId;
      const expandedTasks = await this.expandNeedsSplitTasks({
        adapter,
        projectPath: project.path,
        dalangSessionId: session.id,
        sessionId: currentSessionId,
        model: session.model,
        tasksList: result.data.tasks,
        onSessionId: (sid) => {
          currentSessionId = sid;
        },
        onUsage: (u) => {
          totalUsage = mergeTokenUsage(totalUsage, u);
        },
        onLogLine: (line) =>
          this.events?.emitEvent({
            type: 'lead.log',
            projectId,
            sessionId: session.id,
            phase: 'list',
            line,
          }),
      });

      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'list',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'completed',
        cliSessionId: currentSessionId,
        startedAt,
        logPath: lastLogFilePath ? path.relative(project.path, lastLogFilePath) : null,
        usage: totalUsage,
      });

      const expandedIds = new Set(expandedTasks.map((t) => t.task.id));
      const finalCandidate: PlanContract = {
        version: nextPlanVersion,
        brief_version: briefDto.version,
        milestones: result.data.milestones,
        tasks: expandedTasks.map(({ task }) => ({
          ...task,
          depends_on: task.depends_on.filter((d) => d !== task.id && expandedIds.has(d)),
        })),
      };
      const finalContract = PlanContractSchema.parse(finalCandidate);
      writeArtifactFile(project.path, planFilePath, JSON.stringify(finalContract, null, 2));

      this.db
        .update(sessions)
        .set({
          cliSessionId: currentSessionId,
          phase: 'list',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, session.id))
        .run();

      const planId = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db
        .insert(plans)
        .values({
          id: planId,
          projectId,
          sessionId: session.id,
          briefId: approvedBrief.id,
          version: nextPlanVersion,
          status: 'draft',
          filePath: relPlanPath,
          createdAt: now,
          approvedAt: null,
        })
        .run();

      this.persistPlanTasks(
        planId,
        expandedTasks.map((item, i) => ({ ...item, task: finalContract.tasks[i] })),
      );
      this.syncPlanJsonFile(projectId, planId, session.id);

      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'list',
        ok: true,
      });
      this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: session.id });
      this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: session.id });

      return this.getPlan(projectId, session.id)!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMeta = err as { usage?: TurnTokenUsage; logFilePath?: string };
      totalUsage = mergeTokenUsage(totalUsage, errMeta?.usage);
      const errLogPath = errMeta?.logFilePath ?? lastLogFilePath;
      this.recordLeadTurn({
        projectId,
        sessionId: session.id,
        phase: 'list',
        provider: session.provider as ProviderId,
        model: session.model,
        status: 'failed',
        cliSessionId: session.cliSessionId,
        startedAt,
        failureReason: msg,
        logPath: errLogPath ? path.relative(project.path, errLogPath) : null,
        usage: totalUsage,
      });
      this.events?.emitEvent({
        type: 'lead.turn_finished',
        projectId,
        sessionId: session.id,
        phase: 'list',
        ok: false,
        error: msg,
      });
      throw err;
    }
  }

  private async runContractWithResumeFallback<T>(
    opts: Parameters<typeof runContractTurn<T>>[0],
  ) {
    try {
      return await runContractTurn(opts);
    } catch (err) {
      // Only fall back to a fresh CLI session if the CLI process failed to resume (not on Zod schema errors).
      const msg = err instanceof Error ? err.message : String(err);
      const isValidationError =
        /Agent output failed validation/i.test(msg) &&
        !/session|resume|conversation|thread/i.test(msg);
      if (opts.sessionId && !isValidationError) {
        const firstUsage = (err as { usage?: TurnTokenUsage })?.usage;
        try {
          const fallbackRes = await runContractTurn({ ...opts, sessionId: null });
          const combined = mergeTokenUsage(firstUsage, fallbackRes.usage);
          return {
            ...fallbackRes,
            ...(combined ? { usage: combined } : {}),
          };
        } catch (fallbackErr) {
          if (fallbackErr && typeof fallbackErr === 'object') {
            const fbUsage = (fallbackErr as { usage?: TurnTokenUsage }).usage;
            Object.assign(fallbackErr, { usage: mergeTokenUsage(firstUsage, fbUsage) });
          }
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  private async expandNeedsSplitTasks(opts: {
    adapter: ReturnType<ProviderRegistry['getAdapter']>;
    projectPath: string;
    dalangSessionId: string;
    sessionId: string | null;
    model: string | null;
    tasksList: PlanTaskContract[];
    onSessionId: (sid: string | null) => void;
    onUsage?: (usage: TurnTokenUsage | undefined) => void;
    onLogLine?: (line: string) => void;
  }): Promise<Array<{ task: PlanTaskContract; splitDepth: number; parentExternalId: string | null }>> {
    let working: Array<{ task: PlanTaskContract; splitDepth: number; parentExternalId: string | null }> =
      opts.tasksList.map((t) => ({ task: t, splitDepth: 0, parentExternalId: null }));

    let sessionId = opts.sessionId;
    const usedIds = new Set(working.map((w) => w.task.id));
    let nextNumericId = this.findMaxTaskNumber(usedIds) + 1;
    const tmpDir = getSessionTmpDir(opts.projectPath, opts.dalangSessionId);
    const logsDir = getSessionLogsDir(opts.projectPath, opts.dalangSessionId);

    for (let depth = 0; depth < MAX_SPLIT_DEPTH; depth++) {
      const toSplit = working.filter((item) => item.task.needs_split && item.splitDepth === depth);
      if (toSplit.length === 0) break;

      for (const item of toSplit) {
        const splitTargetFile = path.join(tmpDir, `split-${item.task.id}-d${depth + 1}.json`);
        const relSplitFile = path.relative(opts.projectPath, splitTargetFile).split(path.sep).join('/');

        const prompt = [
          `Task "${item.task.id}" (${item.task.title}) has needs_split: true.`,
          buildLanguageInstruction(this.getLanguage()),
          `Split this task into 2 to 4 smaller, concrete subtasks (depth ${depth + 1} of ${MAX_SPLIT_DEPTH}).`,
          depth + 1 >= MAX_SPLIT_DEPTH
            ? `This is the maximum split depth (${MAX_SPLIT_DEPTH}), so every subtask MUST set "needs_split": false.`
            : `Only set "needs_split": true if a subtask is still genuinely too large.`,
          `Original task:\n${JSON.stringify(item.task, null, 2)}`,
          `Write the result JSON directly to "${relSplitFile}".`,
          `Schema: ${JSON.stringify(z.toJSONSchema(TaskSplitOutputSchema))}`,
        ].join('\n');

        const splitRes = await runContractTurn({
          adapter: opts.adapter,
          projectPath: opts.projectPath,
          sessionId,
          model: opts.model,
          effort: 'high',
          prompt,
          targetFilePath: splitTargetFile,
          schema: TaskSplitOutputSchema,
          schemaName: `split-${item.task.id}-d${depth + 1}`,
          logsDir,
          tmpDir,
          onLogLine: opts.onLogLine,
        });

        sessionId = splitRes.sessionId;
        opts.onSessionId(sessionId);
        opts.onUsage?.(splitRes.usage);

        const replacementIds: string[] = [];
        const newSubtasks = splitRes.data.subtasks.map((sub, idx) => {
          let subId = sub.id;
          if (!subId || usedIds.has(subId)) {
            subId = `T-${String(nextNumericId++).padStart(3, '0')}`;
          }
          usedIds.add(subId);
          replacementIds.push(subId);

          const inheritedDeps =
            idx === 0 && sub.depends_on.length === 0 ? item.task.depends_on : sub.depends_on;
          const forceNoSplit = depth + 1 >= MAX_SPLIT_DEPTH ? false : sub.needs_split;

          return {
            task: {
              ...sub,
              id: subId,
              milestone: sub.milestone || item.task.milestone,
              depends_on: inheritedDeps,
              needs_split: forceNoSplit,
            },
            splitDepth: depth + 1,
            parentExternalId: item.task.id,
          };
        });

        const nextWorking: typeof working = [];
        for (const w of working) {
          if (w.task.id === item.task.id) {
            nextWorking.push(...newSubtasks);
          } else {
            const remappedDeps = w.task.depends_on.flatMap((d) =>
              d === item.task.id ? replacementIds : [d],
            );
            nextWorking.push({
              ...w,
              task: { ...w.task, depends_on: [...new Set(remappedDeps)] },
            });
          }
        }
        working = nextWorking;
      }
    }

    return working.map((w) =>
      w.splitDepth >= MAX_SPLIT_DEPTH && w.task.needs_split
        ? { ...w, task: { ...w.task, needs_split: false } }
        : w,
    );
  }

  private findMaxTaskNumber(ids: Set<string>): number {
    let max = 0;
    for (const id of ids) {
      const m = id.match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  private persistPlanTasks(
    planId: string,
    items: Array<{ task: PlanTaskContract; splitDepth: number; parentExternalId: string | null }>,
  ): void {
    const now = new Date().toISOString();
    const externalToUuid = new Map<string, string>();

    const prepared = items.map((item, idx) => {
      const uuid = crypto.randomUUID();
      externalToUuid.set(item.task.id, uuid);
      return {
        uuid,
        item,
        position: idx,
      };
    });

    for (const entry of prepared) {
      const { task, splitDepth, parentExternalId } = entry.item;
      const status: TaskStatus = task.needs_split ? 'needs_split' : 'ready';
      this.db
        .insert(tasks)
        .values({
          id: entry.uuid,
          planId,
          externalId: task.id,
          title: task.title,
          milestone: task.milestone,
          role: task.role,
          complexity: task.complexity,
          status,
          position: entry.position,
          goal: task.goal,
          filesAllowedJson: JSON.stringify(task.files_allowed),
          filesReferenceJson: JSON.stringify(task.files_reference),
          acceptanceCriteriaJson: JSON.stringify(task.acceptance_criteria),
          verify: task.verify,
          needsSplit: task.needs_split,
          splitDepth,
          parentTaskId: parentExternalId,
          profileOverride: null,
          reviewRounds: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    for (const entry of prepared) {
      for (const depExt of entry.item.task.depends_on) {
        const depUuid = externalToUuid.get(depExt);
        if (depUuid && depUuid !== entry.uuid) {
          this.db
            .insert(taskDependencies)
            .values({ taskId: entry.uuid, dependsOnId: depUuid })
            .onConflictDoNothing()
            .run();
        }
      }
    }
  }

  getPlan(projectId: string, explicitSessionId?: string): PlanDTO | null {
    const project = this.getProjectRow(projectId);
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    if (!sid) return null;

    const planRow = this.db
      .select()
      .from(plans)
      .where(and(eq(plans.projectId, projectId), eq(plans.sessionId, sid)))
      .orderBy(desc(plans.version))
      .get();
    if (!planRow) return null;

    let milestones: PlanMilestone[] = [];
    const absPath = path.join(project.path, planRow.filePath);
    if (fs.existsSync(absPath)) {
      try {
        const parsed = JSON.parse(readArtifactFile(project.path, absPath)) as {
          milestones?: PlanMilestone[];
        };
        milestones = parsed.milestones ?? [];
      } catch {
        milestones = [];
      }
    }

    const taskRows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.planId, planRow.id))
      .orderBy(asc(tasks.position), asc(tasks.externalId))
      .all();

    const uuidToExternal = new Map(taskRows.map((t) => [t.id, t.externalId]));
    const planDeps =
      taskRows.length === 0
        ? []
        : this.db
            .select()
            .from(taskDependencies)
            .where(inArray(taskDependencies.taskId, taskRows.map((t) => t.id)))
            .all();
    const depsByTaskId = new Map<string, string[]>();
    for (const dep of planDeps) {
      const depExt = uuidToExternal.get(dep.dependsOnId);
      if (!depExt) continue;
      const list = depsByTaskId.get(dep.taskId) ?? [];
      list.push(depExt);
      depsByTaskId.set(dep.taskId, list);
    }

    if (milestones.length === 0 && taskRows.length > 0) {
      const seen = new Set<string>();
      for (const t of taskRows) {
        if (!seen.has(t.milestone)) {
          seen.add(t.milestone);
          milestones.push({ id: t.milestone, title: t.milestone, description: '' });
        }
      }
    }

    const taskDtos: TaskDTO[] = taskRows.map((row) => ({
      id: row.id,
      planId: row.planId,
      externalId: row.externalId,
      title: row.title,
      milestone: row.milestone,
      role: row.role as PlanTaskRole,
      complexity: row.complexity as TaskComplexity,
      status: row.status as TaskStatus,
      position: row.position,
      goal: row.goal,
      filesAllowed: JSON.parse(row.filesAllowedJson) as string[],
      filesReference: JSON.parse(row.filesReferenceJson) as string[],
      acceptanceCriteria: JSON.parse(row.acceptanceCriteriaJson) as string[],
      verify: row.verify,
      needsSplit: Boolean(row.needsSplit),
      splitDepth: row.splitDepth,
      parentTaskId: row.parentTaskId,
      delegatedByRunId: row.delegatedByRunId ?? null,
      delegationDepth: row.delegationDepth ?? 0,
      mergeTargetBranch: row.mergeTargetBranch ?? null,
      profileOverride: row.profileOverride,
      reviewRounds: row.reviewRounds,
      branchName: row.branchName ?? null,
      mergeCommitSha: row.mergeCommitSha ?? null,
      rejectionNote: row.rejectionNote ?? null,
      prUrl: row.prUrl ?? null,
      pushedAt: row.pushedAt ?? null,
      dependsOn: depsByTaskId.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return {
      id: planRow.id,
      projectId: planRow.projectId,
      sessionId: planRow.sessionId ?? sid,
      briefId: planRow.briefId ?? null,
      version: planRow.version,
      status: planRow.status as 'draft' | 'approved',
      filePath: planRow.filePath,
      milestones,
      tasks: taskDtos,
      createdAt: planRow.createdAt,
      approvedAt: planRow.approvedAt,
    };
  }

  createTask(projectId: string, input: CreateTaskInput, explicitSessionId?: string): TaskDTO {
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    const plan = sid ? this.getPlan(projectId, sid) : null;
    if (!plan || !sid) {
      throw new Error('No plan exists yet. Generate a plan from an approved brief first.');
    }
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    this.assertMilestone(plan, input.milestone);

    const existingNums = new Set(plan.tasks.map((t) => t.externalId));
    const nextNum = this.findMaxTaskNumber(existingNums) + 1;
    const externalId = `T-${String(nextNum).padStart(3, '0')}`;

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();
    const position = plan.tasks.length;

    this.db
      .insert(tasks)
      .values({
        id: uuid,
        planId: plan.id,
        externalId,
        title: input.title,
        milestone: input.milestone,
        role: input.role,
        complexity: input.complexity,
        status: this.statusFor(input.needsSplit, input.status),
        position,
        goal: input.goal,
        filesAllowedJson: JSON.stringify(input.filesAllowed),
        filesReferenceJson: JSON.stringify(input.filesReference),
        acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
        verify: input.verify,
        needsSplit: input.needsSplit,
        splitDepth: 0,
        parentTaskId: null,
        profileOverride: input.profileOverride ?? null,
        reviewRounds: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.replaceTaskDependencies(plan.id, uuid, externalId, input.dependsOn);
    this.syncPlanJsonFile(projectId, plan.id, sid);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });

    return this.getPlan(projectId, sid)!.tasks.find((t) => t.id === uuid)!;
  }

  updateTask(
    projectId: string,
    taskId: string,
    input: UpdateTaskInput,
    explicitSessionId?: string,
  ): TaskDTO {
    const sid = this.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('Plan not found');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    const target = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!target) throw new Error(`Task not found: ${taskId}`);

    if (input.milestone !== undefined) this.assertMilestone(plan, input.milestone);

    if (input.dependsOn !== undefined) {
      this.replaceTaskDependencies(plan.id, target.id, target.externalId, input.dependsOn);
    }

    const nextNeedsSplit = input.needsSplit ?? target.needsSplit;
    const nextStatus =
      input.needsSplit !== undefined || input.status !== undefined
        ? this.statusFor(nextNeedsSplit, input.status ?? (target.status as EditableTaskStatus))
        : undefined;

    const now = new Date().toISOString();
    this.db
      .update(tasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.complexity !== undefined ? { complexity: input.complexity } : {}),
        ...(nextStatus !== undefined ? { status: nextStatus } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.filesAllowed !== undefined
          ? { filesAllowedJson: JSON.stringify(input.filesAllowed) }
          : {}),
        ...(input.filesReference !== undefined
          ? { filesReferenceJson: JSON.stringify(input.filesReference) }
          : {}),
        ...(input.acceptanceCriteria !== undefined
          ? { acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria) }
          : {}),
        ...(input.verify !== undefined ? { verify: input.verify } : {}),
        ...(input.needsSplit !== undefined ? { needsSplit: input.needsSplit } : {}),
        ...(input.profileOverride !== undefined ? { profileOverride: input.profileOverride } : {}),
        updatedAt: now,
      })
      .where(eq(tasks.id, target.id))
      .run();

    this.syncPlanJsonFile(projectId, plan.id, sid);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });

    return this.getPlan(projectId, sid)!.tasks.find((t) => t.id === target.id)!;
  }

  deleteTask(projectId: string, taskId: string, explicitSessionId?: string): void {
    const sid = this.resolveSessionIdForTask(projectId, taskId, explicitSessionId);
    const plan = sid ? this.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('Plan not found');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    const target = plan.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!target) throw new Error(`Task not found: ${taskId}`);

    this.db.delete(tasks).where(eq(tasks.id, target.id)).run();
    this.syncPlanJsonFile(projectId, plan.id, sid);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });
  }

  reorderTasks(
    projectId: string,
    input: ReorderTasksInput,
    explicitSessionId?: string,
  ): PlanDTO {
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    const plan = sid ? this.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('Plan not found');
    if (plan.status === 'approved') throw new Error('Plan is approved and locked.');

    const now = new Date().toISOString();
    for (const upd of input.updates) {
      this.db
        .update(tasks)
        .set({
          position: upd.position,
          ...(upd.status
            ? { status: upd.status, needsSplit: upd.status === 'needs_split' }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(tasks.id, upd.id), eq(tasks.planId, plan.id)))
        .run();
    }

    this.syncPlanJsonFile(projectId, plan.id, sid);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });
    return this.getPlan(projectId, sid)!;
  }

  approvePlan(projectId: string, explicitSessionId?: string): PlanDTO {
    const sid = this.resolveSessionIdForRead(projectId, explicitSessionId);
    const plan = sid ? this.getPlan(projectId, sid) : null;
    if (!plan || !sid) throw new Error('Plan not found');
    if (plan.status === 'approved') return plan;

    const unsplit = plan.tasks.filter((t) => t.needsSplit);
    if (unsplit.length > 0) {
      throw new Error(
        `Split or clear the needs-split flag on ${unsplit.map((t) => t.externalId).join(', ')} before approving.`,
      );
    }
    if (plan.tasks.length === 0) throw new Error('The plan has no tasks to approve.');

    const now = new Date().toISOString();
    this.db
      .update(plans)
      .set({ status: 'approved', approvedAt: plan.approvedAt ?? now })
      .where(eq(plans.id, plan.id))
      .run();

    this.db
      .update(tasks)
      .set({ status: 'approved', updatedAt: now })
      .where(eq(tasks.planId, plan.id))
      .run();

    this.db
      .update(sessions)
      .set({ phase: 'run', updatedAt: now })
      .where(eq(sessions.id, sid))
      .run();

    this.syncPlanJsonFile(projectId, plan.id, sid);
    this.events?.emitEvent({ type: 'plan.updated', projectId, sessionId: sid });
    this.events?.emitEvent({ type: 'sessions.updated', projectId, sessionId: sid });
    return this.getPlan(projectId, sid)!;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private recordLeadTurn(input: {
    projectId: string;
    sessionId: string | null;
    phase: string;
    provider: ProviderId;
    model: string | null;
    status: 'completed' | 'failed';
    cliSessionId: string | null;
    startedAt: string;
    failureReason?: string | null;
    logPath?: string | null;
    usage?: TurnTokenUsage;
  }): void {
    const finishedAt = new Date().toISOString();
    const effectiveModel = input.usage?.model?.trim() || input.model?.trim() || null;
    const usageFields = usageDbFields(input.provider, effectiveModel, input.usage);
    this.db
      .insert(leadTurns)
      .values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        phase: input.phase,
        provider: input.provider,
        model: effectiveModel,
        status: input.status,
        cliSessionId: input.cliSessionId,
        startedAt: input.startedAt,
        finishedAt,
        failureReason: input.failureReason ?? null,
        logPath: input.logPath ?? null,
        inputTokens: usageFields.inputTokens ?? null,
        outputTokens: usageFields.outputTokens ?? null,
        cacheReadTokens: usageFields.cacheReadTokens ?? null,
        cacheWriteTokens: usageFields.cacheWriteTokens ?? null,
        estimatedCostUsd: usageFields.estimatedCostUsd ?? null,
        costSource: usageFields.costSource ?? null,
      })
      .run();
  }

  private toSessionSummary(row: typeof sessions.$inferSelect): SessionSummaryDTO {
    const sessionBriefs = this.db
      .select()
      .from(briefs)
      .where(eq(briefs.sessionId, row.id))
      .orderBy(desc(briefs.version))
      .all();
    const latestBrief = sessionBriefs[0];

    const sessionPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.sessionId, row.id))
      .orderBy(desc(plans.version))
      .all();
    const latestPlan = sessionPlans[0];

    const planTasks = latestPlan
      ? this.db
          .select({ status: tasks.status, delegationDepth: tasks.delegationDepth })
          .from(tasks)
          .where(eq(tasks.planId, latestPlan.id))
          .all()
          .filter((t) => (t.delegationDepth ?? 0) === 0)
      : [];

    const msgRows = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, row.id))
      .all();

    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title || 'New chat',
      mode: (row.mode as SessionMode) || 'ask',
      workState: (row.workState as SessionWorkState) || 'idle',
      phase: (row.phase as SessionPhase) || 'discuss',
      provider: row.provider as ProviderId,
      model: row.model,
      cliSessionId: row.cliSessionId,
      archivedAt: row.archivedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      latestBriefStatus: latestBrief ? (latestBrief.status as 'draft' | 'approved') : 'none',
      latestBriefVersion: latestBrief ? latestBrief.version : null,
      planStatus: latestPlan ? (latestPlan.status as 'draft' | 'approved') : 'none',
      taskCount: planTasks.length,
      doneTaskCount: planTasks.filter((t) => t.status === 'done').length,
      messageCount: msgRows.length,
      turn: this.runningTurn(row.id),
    };
  }

  /** A turn that never reported finishing (a bug or a crash) must not show as running forever. */
  private runningTurn(sessionId: string): SessionTurnDTO | null {
    const turn = this.runningTurns.get(sessionId);
    return turn && Date.now() - Date.parse(turn.startedAt) < 60 * 60 * 1000 ? turn : null;
  }

  private formatTranscript(history: DiscussMessageDTO[]): string {
    return history
      .filter((m) => m.type !== 'error')
      .map((m) => {
        if (m.type === 'ask' && m.content && typeof m.content === 'object') {
          const ask = m.content as AskMessageContent;
          return `[${m.role}/ask] ${ask.text}`;
        }
        if (m.type === 'images' && m.content && typeof m.content === 'object') {
          const entry = m.content as ChatImageMessage;
          return `[user/images] ${entry.text}\nAttached images: ${entry.images.map((image) => image.name).join(', ')}`;
        }
        return `[${m.role}/${m.type}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
      })
      .join('\n');
  }

  private buildCompletedWorkContext(sessionId: string): string {
    const sessionPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .orderBy(asc(plans.version))
      .all();
    if (sessionPlans.length === 0) return '';

    const taskRows = this.db
      .select()
      .from(tasks)
      .where(inArray(tasks.planId, sessionPlans.map((p) => p.id)))
      .orderBy(asc(tasks.position))
      .all();
    const doneTasks = taskRows.filter((t) => t.status === 'done');
    if (doneTasks.length === 0) return '';

    const lines = ['Completed and merged work in this session:'];
    for (const t of doneTasks) {
      const files = (JSON.parse(t.filesAllowedJson) as string[]).join(', ');
      lines.push(
        `- ${t.externalId}: ${t.title} — Goal: ${t.goal}${files ? ` (files: ${files})` : ''}${t.mergeCommitSha ? ` [merged ${t.mergeCommitSha.slice(0, 8)}]` : ''}`,
      );
    }
    return lines.join('\n');
  }

  /** `needs_split` is both a flag and a kanban column, so the two must never disagree. */
  private statusFor(needsSplit: boolean, requested: EditableTaskStatus): TaskStatus {
    if (needsSplit) return 'needs_split';
    return requested === 'needs_split' ? 'ready' : requested;
  }

  private assertMilestone(plan: PlanDTO, milestone: string): void {
    if (!plan.milestones.some((m) => m.id === milestone)) {
      throw new Error(
        `Unknown milestone "${milestone}". Use one of: ${plan.milestones.map((m) => m.id).join(', ')}.`,
      );
    }
  }

  private replaceTaskDependencies(
    planId: string,
    taskUuid: string,
    taskExternalId: string,
    dependsOnExternalIds: string[],
  ): void {
    const planTasks = this.db.select().from(tasks).where(eq(tasks.planId, planId)).all();
    const extToUuid = new Map(planTasks.map((t) => [t.externalId, t.id]));
    const uuidToExt = new Map(planTasks.map((t) => [t.id, t.externalId]));

    const validDeps = [...new Set(dependsOnExternalIds)].filter(
      (ext) => ext !== taskExternalId && extToUuid.has(ext),
    );

    const allDeps = this.db
      .select()
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, planTasks.map((t) => t.id)))
      .all();
    const edgeMap = new Map<string, string[]>();
    for (const t of planTasks) edgeMap.set(t.externalId, []);
    for (const d of allDeps) {
      const src = uuidToExt.get(d.taskId);
      const dst = uuidToExt.get(d.dependsOnId);
      if (src && dst) {
        edgeMap.get(src)?.push(dst);
      }
    }

    if (hasDependencyCycle(edgeMap, taskExternalId, validDeps)) {
      throw new Error(`Circular dependency detected involving ${taskExternalId}`);
    }

    this.db.delete(taskDependencies).where(eq(taskDependencies.taskId, taskUuid)).run();
    for (const depExt of validDeps) {
      const depUuid = extToUuid.get(depExt);
      if (depUuid) {
        this.db
          .insert(taskDependencies)
          .values({ taskId: taskUuid, dependsOnId: depUuid })
          .onConflictDoNothing()
          .run();
      }
    }
  }

  private syncPlanJsonFile(projectId: string, planId: string, sessionId: string): void {
    const project = this.getProjectRow(projectId);
    const plan = this.getPlan(projectId, sessionId);
    if (!plan || plan.id !== planId) return;

    const briefRow = plan.briefId
      ? this.db.select().from(briefs).where(eq(briefs.id, plan.briefId)).get()
      : null;
    const contract: PlanContract = {
      version: plan.version,
      brief_version: briefRow?.version ?? 1,
      milestones: plan.milestones,
      tasks: plan.tasks.map((t) => ({
        id: t.externalId,
        title: t.title,
        milestone: t.milestone,
        role: t.role,
        complexity: t.complexity,
        depends_on: t.dependsOn,
        goal: t.goal,
        files_allowed: t.filesAllowed,
        files_reference: t.filesReference,
        acceptance_criteria: t.acceptanceCriteria,
        verify: t.verify,
        needs_split: t.needsSplit,
      })),
    };

    writeArtifactFile(
      project.path,
      path.join(project.path, plan.filePath),
      JSON.stringify(contract, null, 2),
    );
  }

  private readBriefRow(projectPath: string, row: typeof briefs.$inferSelect): BriefDTO {
    const absPath = path.join(projectPath, row.filePath);
    const raw = JSON.parse(readArtifactFile(projectPath, absPath)) as unknown;
    const content = BriefContentSchema.parse(raw);
    return {
      id: row.id,
      projectId: row.projectId,
      sessionId: row.sessionId ?? '',
      version: row.version,
      status: row.status as 'draft' | 'approved',
      filePath: row.filePath,
      content,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
    };
  }

  private formatUserDiscussMessage(input: DiscussMessageInput): string {
    if (!input.answers || input.answers.length === 0) {
      return input.message.trim();
    }
    const lines = [input.message.trim(), '', 'Structured answers:'];
    for (const ans of input.answers) {
      const parts = [...ans.selectedOptions];
      if (ans.customText.trim()) parts.push(ans.customText.trim());
      lines.push(`- [${ans.questionId}] ${ans.question}: ${parts.join(', ') || '(skipped)'}`);
    }
    return lines.join('\n');
  }
}
