import crypto from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type {
  AutomationDTO,
  AutomationKind,
  AutomationRunDTO,
  AutomationRunStatus,
  AutomationTriggerSource,
  CreatedAutomationDTO,
  CreateAutomationInput,
  PlanTaskRole,
  TaskComplexity,
  UpdateAutomationInput,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { agentProfiles, automationRuns, automations, projects, tasks } from '../db/schema.js';
import { getNextCronRun, parseCronExpression } from './cron.js';
import type { DalangEventBus } from './events.js';
import type { ExecutionService } from './executor.js';
import type { LeadService } from './lead.js';

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const MAX_PAYLOAD_EXCERPT_CHARS = 1000;
const MAX_PROMPT_PAYLOAD_CHARS = 8000;

export interface AutomationServiceOptions {
  /** Base server URL resolver (e.g. `http://127.0.0.1:4173`) for formatting webhook URLs. */
  baseUrl?: string | (() => string | null);
  /** Scheduler polling interval in ms (default 15s). */
  tickIntervalMs?: number;
}

export function computeWebhookSignature(secret: string, rawBody: Buffer | string): string {
  const mac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${mac}`;
}

export function verifyWebhookSignature(
  secret: string | null | undefined,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  const match = trimmed.match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!match) return false;

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(match[1].toLowerCase(), 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function formatAutomationPrompt(
  template: string,
  meta: { event?: string; payload?: string },
): string {
  const eventText = meta.event?.trim() || 'webhook';
  const rawPayload = meta.payload?.trim() || '';
  const safePayload =
    rawPayload.length > MAX_PROMPT_PAYLOAD_CHARS
      ? `${rawPayload.slice(0, MAX_PROMPT_PAYLOAD_CHARS)}\n...(truncated)`
      : rawPayload;

  let out = template;
  const hasEventToken = out.includes('{{event}}');
  const hasPayloadToken = out.includes('{{payload}}');
  if (hasEventToken) {
    out = out.split('{{event}}').join(eventText);
  }
  if (hasPayloadToken) {
    out = out.split('{{payload}}').join(safePayload || '(empty)');
  }
  if (safePayload && !hasPayloadToken) {
    out = `${out}\n\nTrigger context (${eventText}):\n${safePayload}`;
  }
  return out;
}

function mapTaskStatusToAutomationStatus(taskStatus: string | null): AutomationRunStatus {
  if (taskStatus === 'done') return 'completed';
  if (taskStatus === 'awaiting_merge') return 'awaiting_merge';
  if (taskStatus === 'review_failed') return 'review_failed';
  return 'failed';
}

export class AutomationService {
  private readonly baseUrlResolver: () => string | null;
  private readonly tickIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private readonly activeWatchers = new Map<string, Promise<AutomationRunDTO>>();

  constructor(
    private readonly db: DalangDb,
    private readonly leadService: LeadService,
    private readonly executionService: ExecutionService,
    private readonly events?: DalangEventBus,
    options: AutomationServiceOptions = {},
  ) {
    const urlOpt = options.baseUrl;
    this.baseUrlResolver =
      typeof urlOpt === 'function'
        ? urlOpt
        : () => (typeof urlOpt === 'string' && urlOpt.trim() ? urlOpt.trim().replace(/\/+$/, '') : null);
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.reconcileInterruptedRuns();
  }

  /** A restart drops the in-memory watchers, so settle runs left `running` from the task's stored status. */
  private reconcileInterruptedRuns(): void {
    const stale = this.db.select().from(automationRuns).where(eq(automationRuns.status, 'running')).all();
    const finishedAt = new Date().toISOString();
    for (const run of stale) {
      const taskStatus = run.taskId
        ? (this.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, run.taskId)).get()?.status ?? null)
        : null;
      const status = mapTaskStatusToAutomationStatus(taskStatus);
      const detail = status === 'failed' ? 'Interrupted by server restart' : `task:${taskStatus}`;
      this.db.update(automationRuns).set({ status, detail, finishedAt }).where(eq(automationRuns.id, run.id)).run();
      this.db
        .update(automations)
        .set({ lastStatus: status, lastError: status === 'failed' ? detail : null })
        .where(eq(automations.id, run.automationId))
        .run();
    }
  }

  private resolveProject(projectId: string) {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) {
      throw Object.assign(new Error(`Project not found: ${projectId}`), { statusCode: 404 });
    }
    return row;
  }

  private resolveProfileOverride(profileRef: string | null | undefined): string | null {
    const cleaned = profileRef?.trim();
    if (!cleaned) return null;
    const all = this.db.select().from(agentProfiles).all();
    const matched = all.find((p) => p.id === cleaned || p.name === cleaned);
    if (!matched) {
      throw Object.assign(new Error(`Agent profile not found: ${cleaned}`), { statusCode: 400 });
    }
    return matched.id;
  }

  private toDTO(row: typeof automations.$inferSelect, projectName?: string): AutomationDTO {
    const resolvedProjectName =
      projectName ??
      this.db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).get()?.name ??
      row.projectId;
    const base = this.baseUrlResolver();
    const webhookUrl =
      row.kind === 'webhook' && row.webhookToken
        ? base
          ? `${base}/api/webhooks/${row.webhookToken}`
          : `/api/webhooks/${row.webhookToken}`
        : null;

    return {
      id: row.id,
      projectId: row.projectId,
      projectName: resolvedProjectName,
      name: row.name,
      kind: row.kind as AutomationKind,
      enabled: row.enabled,
      cronExpr: row.cronExpr ?? null,
      webhookToken: row.webhookToken ?? null,
      webhookUrl,
      hasWebhookSecret: Boolean(row.webhookSecret),
      title: row.title,
      prompt: row.prompt,
      role: row.role as PlanTaskRole,
      complexity: row.complexity as TaskComplexity,
      filesAllowed: parseJsonStringArray(row.filesAllowedJson),
      filesReference: parseJsonStringArray(row.filesReferenceJson),
      acceptanceCriteria: parseJsonStringArray(row.acceptanceCriteriaJson),
      verify: row.verify,
      profileOverride: row.profileOverride ?? null,
      allowUnconfined: row.allowUnconfined,
      autoMerge: row.autoMerge,
      lastTriggeredAt: row.lastTriggeredAt ?? null,
      nextRunAt: row.nextRunAt ?? null,
      lastStatus: (row.lastStatus as AutomationRunStatus | null) ?? null,
      lastError: row.lastError ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toRunDTO(row: typeof automationRuns.$inferSelect): AutomationRunDTO {
    return {
      id: row.id,
      automationId: row.automationId,
      projectId: row.projectId,
      triggerSource: row.triggerSource as AutomationTriggerSource,
      sessionId: row.sessionId ?? null,
      taskId: row.taskId ?? null,
      status: row.status as AutomationRunStatus,
      detail: row.detail ?? null,
      payloadExcerpt: row.payloadExcerpt ?? null,
      triggeredAt: row.triggeredAt,
      finishedAt: row.finishedAt ?? null,
    };
  }

  listAutomations(projectId?: string): AutomationDTO[] {
    const projectMap = new Map(
      this.db.select({ id: projects.id, name: projects.name }).from(projects).all().map((p) => [p.id, p.name]),
    );
    const rows = projectId
      ? this.db
          .select()
          .from(automations)
          .where(eq(automations.projectId, projectId))
          .orderBy(desc(automations.createdAt))
          .all()
      : this.db.select().from(automations).orderBy(desc(automations.createdAt)).all();
    return rows.map((row) => this.toDTO(row, projectMap.get(row.projectId)));
  }

  getAutomation(id: string): AutomationDTO {
    const row = this.db.select().from(automations).where(eq(automations.id, id)).get();
    if (!row) {
      throw Object.assign(new Error(`Automation not found: ${id}`), { statusCode: 404 });
    }
    return this.toDTO(row);
  }

  listRuns(automationId: string, limit = 25): AutomationRunDTO[] {
    this.getAutomation(automationId);
    const rows = this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.triggeredAt))
      .limit(Math.max(1, Math.min(limit, 100)))
      .all();
    return rows.map((r) => this.toRunDTO(r));
  }

  createAutomation(input: CreateAutomationInput, now: Date = new Date()): CreatedAutomationDTO {
    const project = this.resolveProject(input.projectId);
    const profileOverride = this.resolveProfileOverride(input.profileOverride);

    let cronExpr: string | null = null;
    let nextRunAt: string | null = null;
    let webhookToken: string | null = null;
    let webhookSecret: string | null = null;

    if (input.kind === 'schedule') {
      if (!input.cronExpr?.trim()) {
        throw Object.assign(new Error('A cron expression is required for scheduled automations.'), {
          statusCode: 400,
        });
      }
      const parsed = parseCronExpression(input.cronExpr);
      cronExpr = parsed.raw;
      nextRunAt = input.enabled ? getNextCronRun(parsed, now).toISOString() : null;
    } else {
      webhookToken = crypto.randomBytes(18).toString('hex');
      webhookSecret = input.webhookSecret?.trim() || crypto.randomBytes(32).toString('hex');
    }

    const id = crypto.randomUUID();
    const nowIso = now.toISOString();
    this.db
      .insert(automations)
      .values({
        id,
        projectId: project.id,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled,
        cronExpr,
        webhookToken,
        webhookSecret,
        title: input.title,
        prompt: input.prompt,
        role: input.role,
        complexity: input.complexity,
        filesAllowedJson: JSON.stringify(input.filesAllowed),
        filesReferenceJson: JSON.stringify(input.filesReference),
        acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
        verify: input.verify,
        profileOverride,
        allowUnconfined: input.allowUnconfined,
        autoMerge: input.autoMerge,
        lastTriggeredAt: null,
        nextRunAt,
        lastStatus: null,
        lastError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    this.events?.emitEvent({ type: 'automation.updated', projectId: project.id, automationId: id });
    const dto = this.getAutomation(id);
    return webhookSecret ? { ...dto, webhookSecret } : dto;
  }

  updateAutomation(id: string, input: UpdateAutomationInput, now: Date = new Date()): AutomationDTO {
    const row = this.db.select().from(automations).where(eq(automations.id, id)).get();
    if (!row) {
      throw Object.assign(new Error(`Automation not found: ${id}`), { statusCode: 404 });
    }

    const nextEnabled = input.enabled !== undefined ? input.enabled : row.enabled;
    let nextCron = row.cronExpr;
    let nextRunAt = row.nextRunAt;

    if (row.kind === 'schedule') {
      if (input.cronExpr !== undefined) {
        if (!input.cronExpr?.trim()) {
          throw Object.assign(new Error('Cron expression cannot be empty for scheduled automations.'), {
            statusCode: 400,
          });
        }
        nextCron = parseCronExpression(input.cronExpr).raw;
      }
      if (nextEnabled && nextCron) {
        if (input.cronExpr !== undefined || (!row.enabled && nextEnabled) || !row.nextRunAt) {
          nextRunAt = getNextCronRun(nextCron, now).toISOString();
        }
      } else {
        nextRunAt = null;
      }
    }

    const nextProfileOverride =
      input.profileOverride !== undefined
        ? this.resolveProfileOverride(input.profileOverride)
        : row.profileOverride;

    const nowIso = now.toISOString();
    this.db
      .update(automations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        enabled: nextEnabled,
        cronExpr: nextCron,
        nextRunAt,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.complexity !== undefined ? { complexity: input.complexity } : {}),
        ...(input.filesAllowed !== undefined ? { filesAllowedJson: JSON.stringify(input.filesAllowed) } : {}),
        ...(input.filesReference !== undefined ? { filesReferenceJson: JSON.stringify(input.filesReference) } : {}),
        ...(input.acceptanceCriteria !== undefined
          ? { acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria) }
          : {}),
        ...(input.verify !== undefined ? { verify: input.verify } : {}),
        profileOverride: nextProfileOverride,
        ...(input.allowUnconfined !== undefined ? { allowUnconfined: input.allowUnconfined } : {}),
        ...(input.autoMerge !== undefined ? { autoMerge: input.autoMerge } : {}),
        updatedAt: nowIso,
      })
      .where(eq(automations.id, id))
      .run();

    this.events?.emitEvent({ type: 'automation.updated', projectId: row.projectId, automationId: id });
    return this.getAutomation(id);
  }

  rotateWebhookSecret(id: string): CreatedAutomationDTO {
    const row = this.db.select().from(automations).where(eq(automations.id, id)).get();
    if (!row) {
      throw Object.assign(new Error(`Automation not found: ${id}`), { statusCode: 404 });
    }
    if (row.kind !== 'webhook') {
      throw Object.assign(new Error('Only webhook automations have a signing secret.'), { statusCode: 400 });
    }
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    this.db
      .update(automations)
      .set({ webhookSecret, updatedAt: new Date().toISOString() })
      .where(eq(automations.id, id))
      .run();
    this.events?.emitEvent({ type: 'automation.updated', projectId: row.projectId, automationId: id });
    return { ...this.getAutomation(id), webhookSecret };
  }

  deleteAutomation(id: string): void {
    const row = this.db.select().from(automations).where(eq(automations.id, id)).get();
    if (!row) {
      throw Object.assign(new Error(`Automation not found: ${id}`), { statusCode: 404 });
    }
    this.db.delete(automations).where(eq(automations.id, id)).run();
    this.events?.emitEvent({ type: 'automation.updated', projectId: row.projectId, automationId: id });
  }

  async handleWebhook(
    token: string,
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    meta: { event?: string; deliveryId?: string } = {},
  ): Promise<{ automation: AutomationDTO; run: AutomationRunDTO }> {
    const row = this.db
      .select()
      .from(automations)
      .where(eq(automations.webhookToken, token))
      .get();
    if (!row || row.kind !== 'webhook') {
      throw Object.assign(new Error('Webhook not found.'), { statusCode: 404 });
    }
    if (!verifyWebhookSignature(row.webhookSecret, rawBody, signatureHeader)) {
      throw Object.assign(
        new Error('Invalid or missing webhook signature. Provide X-Dalang-Signature-256 or X-Hub-Signature-256.'),
        { statusCode: 401 },
      );
    }
    if (!row.enabled) {
      throw Object.assign(new Error('Webhook automation is disabled.'), { statusCode: 409 });
    }

    const payloadText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const detail = meta.deliveryId ? `delivery:${meta.deliveryId}` : meta.event ? `event:${meta.event}` : undefined;
    const run = await this.triggerAutomation(row.id, 'webhook', {
      event: meta.event,
      payload: payloadText,
      detail,
    });
    return { automation: this.getAutomation(row.id), run };
  }

  async triggerAutomation(
    automationId: string,
    source: AutomationTriggerSource,
    opts: {
      event?: string;
      payload?: string;
      detail?: string;
      now?: Date;
    } = {},
  ): Promise<AutomationRunDTO> {
    const row = this.db.select().from(automations).where(eq(automations.id, automationId)).get();
    if (!row) {
      throw Object.assign(new Error(`Automation not found: ${automationId}`), { statusCode: 404 });
    }

    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();
    const runId = crypto.randomUUID();
    const rawPayload = opts.payload?.trim() ?? '';
    const payloadExcerpt = rawPayload
      ? rawPayload.length > MAX_PAYLOAD_EXCERPT_CHARS
        ? `${rawPayload.slice(0, MAX_PAYLOAD_EXCERPT_CHARS)}...`
        : rawPayload
      : null;

    this.db
      .insert(automationRuns)
      .values({
        id: runId,
        automationId: row.id,
        projectId: row.projectId,
        triggerSource: source,
        sessionId: null,
        taskId: null,
        status: 'running',
        detail: opts.detail ?? null,
        payloadExcerpt,
        triggeredAt: nowIso,
        finishedAt: null,
      })
      .run();

    this.db
      .update(automations)
      .set({
        lastTriggeredAt: nowIso,
        lastStatus: 'running',
        lastError: null,
        updatedAt: nowIso,
      })
      .where(eq(automations.id, row.id))
      .run();

    const filesAllowed = parseJsonStringArray(row.filesAllowedJson);
    const filesReference = parseJsonStringArray(row.filesReferenceJson);
    const acceptanceCriteria = parseJsonStringArray(row.acceptanceCriteriaJson);
    const goal = formatAutomationPrompt(row.prompt, {
      event: opts.event,
      payload: opts.payload,
    });
    const sourceLabel =
      source === 'schedule' ? 'Schedule' : source === 'webhook' ? 'Webhook' : 'Manual';
    const sessionTitle = `[${sourceLabel}] ${row.name}`;

    let createdSessionId: string | null = null;
    let createdTaskId: string | null = null;

    try {
      const created = this.leadService.createDirectApprovedTask(row.projectId, {
        sessionTitle,
        userMessage: `Triggered by ${sourceLabel.toLowerCase()} automation "${row.name}": ${row.title}`,
        title: row.title,
        goal,
        role: row.role as PlanTaskRole,
        complexity: row.complexity as TaskComplexity,
        filesAllowed,
        filesReference,
        acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : ['Verify command passes'],
        verify: row.verify,
        profileOverride: row.profileOverride,
        milestone: sourceLabel,
      });
      createdSessionId = created.session.id;
      createdTaskId = created.task.id;

      this.db
        .update(automationRuns)
        .set({ sessionId: createdSessionId, taskId: createdTaskId })
        .where(eq(automationRuns.id, runId))
        .run();

      await this.executionService.startExecution(row.projectId, {
        sessionId: createdSessionId,
        taskId: createdTaskId,
        allowUnconfined: row.allowUnconfined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = (err as { statusCode?: number }).statusCode;
      const failStatus: AutomationRunStatus = statusCode === 409 ? 'skipped' : 'failed';
      const finishedAt = new Date().toISOString();

      // If we created a fresh session before startExecution failed, delete the empty session so it doesn't clutter history.
      if (createdSessionId) {
        try {
          this.leadService.deleteSession(row.projectId, createdSessionId);
        } catch {
          // ignore cleanup failure
        }
      }

      this.db
        .update(automationRuns)
        .set({
          sessionId: null,
          taskId: null,
          status: failStatus,
          detail: message,
          finishedAt,
        })
        .where(eq(automationRuns.id, runId))
        .run();
      this.db
        .update(automations)
        .set({
          lastStatus: failStatus,
          lastError: message,
          updatedAt: finishedAt,
        })
        .where(eq(automations.id, row.id))
        .run();

      this.events?.emitEvent({
        type: 'automation.finished',
        projectId: row.projectId,
        automationId: row.id,
        automationRunId: runId,
        status: failStatus,
        error: message,
      });
      this.events?.emitEvent({
        type: 'automation.updated',
        projectId: row.projectId,
        automationId: row.id,
      });

      return this.toRunDTO(
        this.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()!,
      );
    }

    this.events?.emitEvent({
      type: 'automation.triggered',
      projectId: row.projectId,
      automationId: row.id,
      automationRunId: runId,
      triggerSource: source,
      taskId: createdTaskId,
    });
    this.events?.emitEvent({
      type: 'automation.updated',
      projectId: row.projectId,
      automationId: row.id,
    });

    const watcher = this.watchAutomationRun(
      runId,
      row.id,
      row.projectId,
      createdTaskId,
      row.autoMerge,
      row.allowUnconfined,
    );
    this.activeWatchers.set(runId, watcher);
    void watcher.finally(() => {
      this.activeWatchers.delete(runId);
    });

    return this.toRunDTO(
      this.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()!,
    );
  }

  private async watchAutomationRun(
    runId: string,
    automationId: string,
    projectId: string,
    taskId: string,
    autoMerge: boolean,
    allowUnconfined: boolean,
  ): Promise<AutomationRunDTO> {
    let finalTaskStatus = await this.executionService.waitForTaskExecution(taskId);
    let errorDetail: string | null = null;

    if (finalTaskStatus === 'awaiting_merge' && autoMerge) {
      try {
        await this.executionService.approveMergeTask(projectId, taskId, {
          allowUnconfined,
          runIntegration: true,
          allowFailedReview: false,
        });
        finalTaskStatus = 'done';
      } catch (err) {
        errorDetail = `Auto-merge failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const finalStatus: AutomationRunStatus = errorDetail
      ? 'failed'
      : mapTaskStatusToAutomationStatus(finalTaskStatus);
    const finishedAt = new Date().toISOString();

    const existingRun = this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .get();
    const detail = errorDetail ?? existingRun?.detail ?? `task:${finalTaskStatus ?? 'unknown'}`;

    this.db
      .update(automationRuns)
      .set({
        status: finalStatus,
        detail,
        finishedAt,
      })
      .where(eq(automationRuns.id, runId))
      .run();

    this.db
      .update(automations)
      .set({
        lastStatus: finalStatus,
        lastError: errorDetail,
        updatedAt: finishedAt,
      })
      .where(eq(automations.id, automationId))
      .run();

    this.events?.emitEvent({
      type: 'automation.finished',
      projectId,
      automationId,
      automationRunId: runId,
      status: finalStatus,
      ...(errorDetail ? { error: errorDetail } : {}),
    });
    this.events?.emitEvent({
      type: 'automation.updated',
      projectId,
      automationId,
    });

    const updated = this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .get();
    return updated ? this.toRunDTO(updated) : {
      id: runId,
      automationId,
      projectId,
      triggerSource: 'manual',
      sessionId: null,
      taskId,
      status: finalStatus,
      detail,
      payloadExcerpt: null,
      triggeredAt: finishedAt,
      finishedAt,
    };
  }

  /**
   * Checks all enabled schedule automations and fires any whose `nextRunAt <= now`.
   * Advances `nextRunAt` before starting execution to prevent duplicate triggers.
   */
  async tick(now: Date = new Date()): Promise<AutomationRunDTO[]> {
    const nowIso = now.toISOString();
    const scheduleRows = this.db
      .select()
      .from(automations)
      .where(eq(automations.kind, 'schedule'))
      .all();

    const triggered: AutomationRunDTO[] = [];
    for (const row of scheduleRows) {
      if (!row.enabled || !row.cronExpr) continue;
      if (!row.nextRunAt) {
        const computed = getNextCronRun(row.cronExpr, now).toISOString();
        this.db
          .update(automations)
          .set({ nextRunAt: computed, updatedAt: nowIso })
          .where(eq(automations.id, row.id))
          .run();
        continue;
      }
      if (row.nextRunAt > nowIso) continue;

      // Advance nextRunAt first so overlapping ticks cannot double-fire.
      const nextRunAt = getNextCronRun(row.cronExpr, now).toISOString();
      this.db
        .update(automations)
        .set({ nextRunAt, updatedAt: nowIso })
        .where(eq(automations.id, row.id))
        .run();

      const run = await this.triggerAutomation(row.id, 'schedule', { now });
      triggered.push(run);
    }

    return triggered;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = this.tick()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.tickInFlight = null;
        });
    }, this.tickIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight) {
      await this.tickInFlight.catch(() => undefined);
    }
  }

  async waitForRun(automationRunId: string): Promise<AutomationRunDTO | null> {
    const watcher = this.activeWatchers.get(automationRunId);
    if (watcher) {
      return watcher;
    }
    const row = this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, automationRunId))
      .get();
    return row ? this.toRunDTO(row) : null;
  }

  async waitForAllPending(): Promise<void> {
    while (this.activeWatchers.size > 0) {
      await Promise.all([...this.activeWatchers.values()].map((p) => p.catch(() => undefined)));
    }
  }
}
