import crypto from 'node:crypto';
import path from 'node:path';
import { desc, eq, isNull } from 'drizzle-orm';
import {
  DALANG_VERSION,
  ExternalMcpApproveMergeInputSchema,
  ExternalMcpGetProjectInputSchema,
  ExternalMcpGetRunLogInputSchema,
  ExternalMcpGetTaskInputSchema,
  ExternalMcpListAutomationsInputSchema,
  ExternalMcpListSessionsInputSchema,
  ExternalMcpListTasksInputSchema,
  ExternalMcpRejectTaskInputSchema,
  ExternalMcpStartTaskInputSchema,
  ExternalMcpStopTaskInputSchema,
  ExternalMcpTriggerAutomationInputSchema,
  type CreatedMcpTokenDTO,
  type CreateMcpTokenInput,
  type McpAccessLevel,
  type McpTokenDTO,
  type TaskOutputKind,
} from '@dalang/shared';
import type { DalangDb } from '../db/client.js';
import { agentProfiles, mcpTokens, projects } from '../db/schema.js';
import type { AutomationService } from './automation.js';
import { formatZodError } from './contract.js';
import type { ExecutionService } from './executor.js';
import type { LeadService } from './lead.js';
import type { McpHttpRequest, McpHttpResponse } from './mcp.js';
import { detectIntegrationCommand, type ProjectService } from './project.js';

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const TOKEN_PREFIX_TAG = 'dlm_';

export interface ExternalMcpScope {
  tokenId: string;
  name: string;
  accessLevel: McpAccessLevel;
  projectId: string | null;
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export class ExternalMcpTokenService {
  private readonly endpointUrlResolver: () => string | null;

  constructor(
    private readonly db: DalangDb,
    options: { endpointUrl?: string | (() => string | null) } = {},
  ) {
    const opt = options.endpointUrl;
    this.endpointUrlResolver =
      typeof opt === 'function'
        ? opt
        : () => (typeof opt === 'string' && opt.trim() ? opt.trim() : null);
  }

  private toDTO(row: typeof mcpTokens.$inferSelect, projectMap?: Map<string, string>): McpTokenDTO {
    const projectName = row.projectId
      ? (projectMap?.get(row.projectId) ??
          this.db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).get()?.name ??
          null)
      : null;
    return {
      id: row.id,
      name: row.name,
      accessLevel: row.accessLevel as McpAccessLevel,
      tokenPrefix: row.tokenPrefix,
      projectId: row.projectId ?? null,
      projectName,
      lastUsedAt: row.lastUsedAt ?? null,
      revokedAt: row.revokedAt ?? null,
      createdAt: row.createdAt,
    };
  }

  listTokens(): McpTokenDTO[] {
    const projectMap = new Map(
      this.db.select({ id: projects.id, name: projects.name }).from(projects).all().map((p) => [p.id, p.name]),
    );
    const rows = this.db.select().from(mcpTokens).orderBy(desc(mcpTokens.createdAt)).all();
    return rows.map((r) => this.toDTO(r, projectMap));
  }

  createToken(input: CreateMcpTokenInput): CreatedMcpTokenDTO {
    const projectId = input.projectId?.trim() || null;
    if (projectId) {
      const proj = this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
      if (!proj) {
        throw Object.assign(new Error(`Project not found: ${projectId}`), { statusCode: 404 });
      }
    }

    const rawToken = `${TOKEN_PREFIX_TAG}${crypto.randomBytes(32).toString('hex')}`;
    const tokenPrefix = rawToken.slice(0, 12);
    const tokenHash = hashToken(rawToken);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .insert(mcpTokens)
      .values({
        id,
        name: input.name,
        accessLevel: input.accessLevel,
        tokenPrefix,
        tokenHash,
        projectId,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
      })
      .run();

    const created = this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get()!;
    return {
      tokenInfo: this.toDTO(created),
      token: rawToken,
      endpointUrl: this.endpointUrlResolver(),
    };
  }

  revokeToken(id: string): McpTokenDTO {
    const row = this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get();
    if (!row) {
      throw Object.assign(new Error(`MCP token not found: ${id}`), { statusCode: 404 });
    }
    const now = row.revokedAt ?? new Date().toISOString();
    this.db.update(mcpTokens).set({ revokedAt: now }).where(eq(mcpTokens.id, id)).run();
    return this.toDTO(this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get()!);
  }

  deleteToken(id: string): void {
    const row = this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get();
    if (!row) {
      throw Object.assign(new Error(`MCP token not found: ${id}`), { statusCode: 404 });
    }
    this.db.delete(mcpTokens).where(eq(mcpTokens.id, id)).run();
  }

  authenticate(authorizationHeader: string | undefined): ExternalMcpScope | null {
    if (!authorizationHeader) return null;
    const match = authorizationHeader.trim().match(/^Bearer\s+(\S+)$/i);
    if (!match) return null;
    const candidateHash = Buffer.from(hashToken(match[1]), 'hex');

    const activeRows = this.db
      .select()
      .from(mcpTokens)
      .where(isNull(mcpTokens.revokedAt))
      .all();

    let matched: typeof mcpTokens.$inferSelect | null = null;
    for (const row of activeRows) {
      const expectedHash = Buffer.from(row.tokenHash, 'hex');
      if (candidateHash.length === expectedHash.length && crypto.timingSafeEqual(candidateHash, expectedHash)) {
        matched = row;
      }
    }
    if (!matched) return null;

    const now = new Date().toISOString();
    this.db.update(mcpTokens).set({ lastUsedAt: now }).where(eq(mcpTokens.id, matched.id)).run();
    return {
      tokenId: matched.id,
      name: matched.name,
      accessLevel: matched.accessLevel as McpAccessLevel,
      projectId: matched.projectId ?? null,
    };
  }
}

export const EXTERNAL_MCP_READ_TOOLS = [
  {
    name: 'list_projects',
    description: 'List DALANG projects registered on this local instance (respects token project scope).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_project',
    description: 'Read project metadata, PROJECT.md, sessions, and active execution status.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID, exact project name, or absolute repository path.',
        },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sessions',
    description: 'List saved sessions for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        include_archived: { type: 'boolean', default: false },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks for a project (latest or specified session), including status and review rounds.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        session_id: { type: 'string', description: 'Optional session ID; defaults to working or latest session.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Get full status of a task: metadata, runs, latest review findings, and branch diff summary.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        task_id: { type: 'string', description: 'Task UUID or external_id (e.g. T-001).' },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_run_log',
    description: 'Read the captured log lines of a task run.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        run_id: { type: 'string', description: 'Run ID.' },
        tail_lines: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
      required: ['project_id', 'run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_automations',
    description: 'List scheduled and webhook automations (secrets are never returned).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID, name, or path filter.' },
      },
      additionalProperties: false,
    },
  },
] as const;

export const EXTERNAL_MCP_WRITE_TOOLS = [
  {
    name: 'start_task',
    description:
      'Create and run a DALANG task in an isolated git worktree with verification and automated review. Runs headless without opening the UI. Requires a full-access MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, exact name, or absolute path.' },
        title: { type: 'string', description: 'Short task title.' },
        prompt: { type: 'string', description: 'Detailed goal and instructions for the executor.' },
        role: { type: 'string', enum: ['engineer', 'qa'], default: 'engineer' },
        complexity: { type: 'string', enum: ['low', 'medium', 'high'], default: 'low' },
        output: {
          type: 'string',
          enum: ['files', 'answer'],
          default: 'files',
          description: 'files (default): modifies project files; answer: writes a standalone markdown answer without modifying project files.',
        },
        files_allowed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob patterns the executor may edit (empty means full workspace for files tasks, or no project files for answer tasks).',
        },
        files_reference: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional reference file paths for the executor.',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Verifiable acceptance criteria checked by the automated reviewer.',
        },
        verify: {
          type: 'string',
          description: 'Optional shell command to verify the work. For files tasks, falls back to the project integration command if omitted; if none exists, review checks acceptance criteria directly.',
        },
        profile: {
          type: 'string',
          description: 'Optional DALANG agent profile ID or name override.',
        },
        allow_unconfined: {
          type: 'boolean',
          default: false,
          description: 'Allow running without OS sandbox when unavailable on this host.',
        },
        auto_merge: {
          type: 'boolean',
          default: false,
          description: 'When true and mode is wait, automatically merge into the base branch if automated review passes.',
        },
        mode: {
          type: 'string',
          enum: ['wait', 'async'],
          default: 'wait',
          description: 'wait (default): block until coding and review finish; async: return task_id immediately.',
        },
      },
      required: ['project_id', 'title', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_task',
    description: 'Stop a running DALANG task. Requires a full-access MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        task_id: { type: 'string', description: 'Task UUID or external_id.' },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'approve_merge',
    description: 'Approve Gate 2 and merge a reviewed task branch into the base branch. Requires a full-access MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        task_id: { type: 'string', description: 'Task UUID or external_id.' },
        run_integration: { type: 'boolean', default: true },
        allow_unconfined: { type: 'boolean', default: false },
        allow_failed_review: { type: 'boolean', default: false },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'reject_task',
    description: 'Reject an unmerged task and optionally requeue it with feedback. Requires a full-access MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, name, or path.' },
        task_id: { type: 'string', description: 'Task UUID or external_id.' },
        note: { type: 'string', default: '' },
        requeue: { type: 'boolean', default: false },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'trigger_automation',
    description: 'Trigger an existing scheduled or webhook automation immediately. Requires a full-access MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        automation_id: { type: 'string', description: 'Automation UUID.' },
        event: { type: 'string', description: 'Optional event label.' },
        payload: { type: 'string', description: 'Optional payload context.' },
      },
      required: ['automation_id'],
      additionalProperties: false,
    },
  },
] as const;

const WRITE_TOOL_NAMES = new Set<string>(EXTERNAL_MCP_WRITE_TOOLS.map((t) => t.name));

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export class ExternalMcpService {
  constructor(
    private readonly db: DalangDb,
    private readonly tokenService: ExternalMcpTokenService,
    private readonly projectService: ProjectService,
    private readonly leadService: LeadService,
    private readonly executionService: ExecutionService,
    private readonly automationService: AutomationService,
  ) {}

  private resolveScopedProject(scope: ExternalMcpScope, ref: string) {
    const cleaned = ref.trim();
    const resolvedPath = path.resolve(cleaned);
    const all = this.projectService.listProjects();
    const matched = all.find(
      (p) => p.id === cleaned || p.name === cleaned || p.path === cleaned || p.path === resolvedPath,
    );
    if (!matched) {
      throw new Error(`Project not found: ${ref}`);
    }
    if (scope.projectId && matched.id !== scope.projectId) {
      throw new Error('Forbidden: this MCP token is scoped to a different project.');
    }
    return matched;
  }

  private resolveProfileId(ref: string | undefined): string | null {
    const cleaned = ref?.trim();
    if (!cleaned) return null;
    const all = this.db.select().from(agentProfiles).all();
    const matched = all.find((p) => p.id === cleaned || p.name === cleaned);
    if (!matched) {
      throw new Error(`Agent profile not found: ${cleaned}`);
    }
    return matched.id;
  }

  private async buildTaskSnapshot(projectId: string, taskId: string, sessionId?: string) {
    const sid = this.leadService.resolveSessionIdForTask(projectId, taskId, sessionId);
    const plan = sid ? this.leadService.getPlan(projectId, sid) : null;
    const task = plan?.tasks.find((t) => t.id === taskId || t.externalId === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const execState = await this.executionService.getExecutionState(projectId, sid ?? undefined);
    const guardState = await this.executionService.getGuardState(projectId, sid ?? undefined);
    const taskRuns = execState.runs.filter((r) => r.taskId === task.id);
    const guardEntry = guardState.tasks.find((g) => g.task.id === task.id);

    let changedFiles: string[] = [];
    if (guardEntry?.diffAvailable) {
      try {
        const diff = await this.executionService.getTaskDiffForTask(projectId, task.id);
        changedFiles = diff.files.map((f) => f.path);
      } catch {
        // diff optional if branch was already cleaned up
      }
    }

    return {
      project_id: projectId,
      session_id: sid,
      task_id: task.id,
      external_id: task.externalId,
      title: task.title,
      output: task.output,
      verify: task.verify,
      status: task.status,
      branch_name: task.branchName,
      merge_commit_sha: task.mergeCommitSha,
      review_rounds: task.reviewRounds,
      ...(task.output === 'answer'
        ? {
            answer: guardEntry?.answer ?? null,
            answer_path: guardEntry?.answerPath ?? null,
          }
        : {}),
      latest_run: taskRuns[0]
        ? {
            id: taskRuns[0].id,
            provider: taskRuns[0].provider,
            model: taskRuns[0].model,
            status: taskRuns[0].status,
            failure_reason: taskRuns[0].failureReason,
            summary: taskRuns[0].result?.summary ?? null,
            started_at: taskRuns[0].startedAt,
            finished_at: taskRuns[0].finishedAt,
          }
        : null,
      latest_review: guardEntry?.latestReview
        ? {
            round: guardEntry.latestReview.round,
            status: guardEntry.latestReview.status,
            reviewer_provider: guardEntry.latestReview.reviewerProvider,
            verify_exit_code: guardEntry.latestReview.verifyExitCode,
            summary: guardEntry.latestReview.contract.summary ?? null,
            findings: guardEntry.latestReview.contract.findings,
          }
        : null,
      changed_files: changedFiles,
      can_approve_merge: guardEntry?.canApproveMerge ?? false,
    };
  }

  private async callTool(scope: ExternalMcpScope, toolName: string, rawArgs: unknown): Promise<{ data: unknown; isError?: boolean }> {
    if (WRITE_TOOL_NAMES.has(toolName) && scope.accessLevel !== 'full-access') {
      return {
        data: 'Forbidden: this MCP token has read-only access. Create a full-access token in Config -> Automation to run mutating tools.',
        isError: true,
      };
    }

    if (toolName === 'list_projects') {
      const all = this.projectService.listProjects();
      const filtered = scope.projectId ? all.filter((p) => p.id === scope.projectId) : all;
      return { data: { projects: filtered } };
    }

    if (toolName === 'get_project') {
      const parsed = ExternalMcpGetProjectInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const md = this.projectService.readProjectMd(project.id);
      const sessionsList = this.leadService.listSessions(project.id);
      const execution = await this.executionService.getExecutionState(project.id);
      return {
        data: {
          project,
          project_md: md.content,
          sessions: sessionsList,
          active_runs: execution.activeRuns,
          queue_running: execution.queueRunning,
        },
      };
    }

    if (toolName === 'list_sessions') {
      const parsed = ExternalMcpListSessionsInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const sessionsList = this.leadService.listSessions(project.id, {
        includeArchived: parsed.data.include_archived,
      });
      return { data: { project_id: project.id, sessions: sessionsList } };
    }

    if (toolName === 'list_tasks') {
      const parsed = ExternalMcpListTasksInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const plan = this.leadService.getPlan(project.id, parsed.data.session_id);
      return {
        data: {
          project_id: project.id,
          session_id: plan?.sessionId ?? null,
          plan_status: plan?.status ?? 'none',
          tasks: plan?.tasks ?? [],
        },
      };
    }

    if (toolName === 'get_task') {
      const parsed = ExternalMcpGetTaskInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const snapshot = await this.buildTaskSnapshot(project.id, parsed.data.task_id);
      return { data: snapshot };
    }

    if (toolName === 'get_run_log') {
      const parsed = ExternalMcpGetRunLogInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const log = await this.executionService.getRunLog(project.id, parsed.data.run_id);
      const allLines = log.content ? log.content.split(/\r?\n/) : [];
      const lines = allLines.slice(-parsed.data.tail_lines);
      return {
        data: {
          project_id: project.id,
          run_id: parsed.data.run_id,
          log_path: log.logPath,
          total_lines: allLines.length,
          lines,
        },
      };
    }

    if (toolName === 'list_automations') {
      const parsed = ExternalMcpListAutomationsInputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      let filterProjectId = scope.projectId ?? undefined;
      if (parsed.data.project_id) {
        const project = this.resolveScopedProject(scope, parsed.data.project_id);
        filterProjectId = project.id;
      }
      return { data: { automations: this.automationService.listAutomations(filterProjectId) } };
    }

    if (toolName === 'start_task') {
      const parsed = ExternalMcpStartTaskInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const input = parsed.data;
      const project = this.resolveScopedProject(scope, input.project_id);
      const output: TaskOutputKind = input.output ?? 'files';
      const verifyCmd =
        input.verify !== undefined
          ? input.verify?.trim() || null
          : output === 'answer'
            ? null
            : project.integrationCommand?.trim() || detectIntegrationCommand(project.path) || null;
      const profileOverride = this.resolveProfileId(input.profile);
      const criteria =
        input.acceptance_criteria && input.acceptance_criteria.length > 0
          ? input.acceptance_criteria
          : [
              verifyCmd
                ? `Task goal satisfied and verify command \`${verifyCmd}\` exits with code 0`
                : 'Task goal satisfied',
            ];

      const created = this.leadService.createDirectApprovedTask(project.id, {
        sessionTitle: `[MCP] ${input.title}`,
        userMessage: `Started by external MCP client "${scope.name}": ${input.title}\n\n${input.prompt}`,
        title: input.title,
        goal: input.prompt,
        role: input.role,
        complexity: input.complexity,
        output,
        filesAllowed: input.files_allowed,
        filesReference: input.files_reference,
        acceptanceCriteria: criteria,
        verify: verifyCmd,
        profileOverride,
        milestone: 'MCP',
      });

      try {
        await this.executionService.startExecution(project.id, {
          sessionId: created.session.id,
          taskId: created.task.id,
          allowUnconfined: input.allow_unconfined,
        });
      } catch (err) {
        try {
          this.leadService.deleteSession(project.id, created.session.id);
        } catch {
          // ignore cleanup failure
        }
        throw err;
      }

      if (input.mode === 'async') {
        const snapshot = await this.buildTaskSnapshot(project.id, created.task.id, created.session.id);
        return { data: snapshot };
      }

      let finalStatus = await this.executionService.waitForTaskExecution(created.task.id);
      let mergeError: string | null = null;
      if (finalStatus === 'awaiting_merge' && input.auto_merge) {
        try {
          await this.executionService.approveMergeTask(project.id, created.task.id, {
            allowUnconfined: input.allow_unconfined,
            runIntegration: true,
            allowFailedReview: false,
          });
          finalStatus = 'done';
        } catch (err) {
          mergeError = err instanceof Error ? err.message : String(err);
        }
      }

      const snapshot = await this.buildTaskSnapshot(project.id, created.task.id, created.session.id);
      const failed = Boolean(mergeError) || finalStatus === 'failed' || finalStatus === 'review_failed' || finalStatus === 'stopped';
      return {
        data: mergeError ? { ...snapshot, merge_error: mergeError } : snapshot,
        isError: failed,
      };
    }

    if (toolName === 'stop_task') {
      const parsed = ExternalMcpStopTaskInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const res = await this.executionService.stopExecution(project.id, parsed.data.task_id);
      return { data: { project_id: project.id, task_id: parsed.data.task_id, ...res } };
    }

    if (toolName === 'approve_merge') {
      const parsed = ExternalMcpApproveMergeInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const result = await this.executionService.approveMergeTask(project.id, parsed.data.task_id, {
        runIntegration: parsed.data.run_integration,
        allowUnconfined: parsed.data.allow_unconfined,
        allowFailedReview: parsed.data.allow_failed_review,
      });
      return { data: result };
    }

    if (toolName === 'reject_task') {
      const parsed = ExternalMcpRejectTaskInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const project = this.resolveScopedProject(scope, parsed.data.project_id);
      const task = await this.executionService.rejectTask(project.id, parsed.data.task_id, {
        note: parsed.data.note,
        requeue: parsed.data.requeue,
      });
      return { data: { task } };
    }

    if (toolName === 'trigger_automation') {
      const parsed = ExternalMcpTriggerAutomationInputSchema.safeParse(rawArgs);
      if (!parsed.success) return { data: `Invalid arguments: ${formatZodError(parsed.error)}`, isError: true };
      const auto = this.automationService.getAutomation(parsed.data.automation_id);
      if (scope.projectId && auto.projectId !== scope.projectId) {
        return { data: 'Forbidden: this MCP token is scoped to a different project.', isError: true };
      }
      const run = await this.automationService.triggerAutomation(auto.id, 'manual', {
        event: parsed.data.event,
        payload: parsed.data.payload,
        detail: `mcp:${scope.name}`,
      });
      return {
        data: { automation_id: auto.id, run },
        isError: run.status === 'failed' || run.status === 'skipped',
      };
    }

    return { data: null };
  }

  private async handleSingleRpc(scope: ExternalMcpScope, raw: unknown): Promise<unknown | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    const req = raw as JsonRpcRequest;
    const hasId = Object.prototype.hasOwnProperty.call(req, 'id') && req.id !== undefined;
    const id = hasId ? (req.id as string | number | null) : null;

    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return jsonRpcError(id, -32600, 'Invalid JSON-RPC 2.0 request');
    }

    if (!hasId) {
      return null;
    }

    if (req.method === 'initialize') {
      const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
      const clientVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
          ? params.protocolVersion.trim()
          : DEFAULT_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion: clientVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'dalang',
          version: DALANG_VERSION,
        },
      });
    }

    if (req.method === 'ping') {
      return jsonRpcResult(id, {});
    }

    if (req.method === 'tools/list') {
      const tools =
        scope.accessLevel === 'full-access'
          ? [...EXTERNAL_MCP_READ_TOOLS, ...EXTERNAL_MCP_WRITE_TOOLS]
          : [...EXTERNAL_MCP_READ_TOOLS];
      return jsonRpcResult(id, { tools });
    }

    if (req.method === 'tools/call') {
      const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : null;
      const toolName = typeof params?.name === 'string' ? params.name : '';
      const toolArgs = params?.arguments ?? {};
      const allKnown = new Set<string>([
        ...EXTERNAL_MCP_READ_TOOLS.map((t) => t.name),
        ...EXTERNAL_MCP_WRITE_TOOLS.map((t) => t.name),
      ]);
      if (!allKnown.has(toolName)) {
        return jsonRpcError(id, -32601, `Unknown MCP tool: ${toolName}`);
      }
      try {
        const res = await this.callTool(scope, toolName, toolArgs);
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
        return jsonRpcResult(id, {
          content: [{ type: 'text', text }],
          isError: Boolean(res.isError),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        });
      }
    }

    return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
  }

  authenticate(authorizationHeader: string | undefined): ExternalMcpScope | null {
    return this.tokenService.authenticate(authorizationHeader);
  }

  async handleHttpRequest(scope: ExternalMcpScope, req: McpHttpRequest): Promise<McpHttpResponse> {
    const method = req.method.toUpperCase();
    if (method === 'DELETE') {
      return {
        statusCode: 204,
        headers: { 'Cache-Control': 'no-store' },
      };
    }
    if (method === 'GET') {
      return {
        statusCode: 405,
        headers: { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' },
        body: jsonRpcError(null, -32600, 'Use POST for MCP JSON-RPC requests.'),
      };
    }
    if (method !== 'POST') {
      return {
        statusCode: 405,
        headers: { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' },
        body: jsonRpcError(null, -32600, `Unsupported HTTP method: ${method}`),
      };
    }

    if (Array.isArray(req.body)) {
      if (req.body.length === 0) {
        return {
          statusCode: 400,
          headers: { 'Cache-Control': 'no-store' },
          body: jsonRpcError(null, -32600, 'Invalid empty JSON-RPC batch'),
        };
      }
      const responses = (
        await Promise.all(req.body.map((item) => this.handleSingleRpc(scope, item)))
      ).filter((res) => res !== null);
      if (responses.length === 0) {
        return { statusCode: 202, headers: { 'Cache-Control': 'no-store' } };
      }
      return {
        statusCode: 200,
        headers: { 'Cache-Control': 'no-store' },
        body: responses,
      };
    }

    const response = await this.handleSingleRpc(scope, req.body);
    if (response === null) {
      return { statusCode: 202, headers: { 'Cache-Control': 'no-store' } };
    }
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: response,
    };
  }
}
