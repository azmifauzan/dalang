import { z } from 'zod';

export const DALANG_VERSION = '0.14.12';

export const MAX_DELEGATION_DEPTH = 1;
export const DEFAULT_MAX_SUBTASKS_PER_TASK = 6;

export const UiLanguageSchema = z.enum(['en', 'id']);
export type UiLanguage = z.infer<typeof UiLanguageSchema>;

export const ProviderIdSchema = z.enum(['claude-code', 'codex', 'antigravity']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const SandboxEngineSchema = z.enum(['bwrap', 'sandbox-exec', 'windows-mxc', 'none']);
export type SandboxEngine = z.infer<typeof SandboxEngineSchema>;

export const EFFORT_LEVEL_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVEL_ORDER);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/** Stable per-account key: `<provider>` for the default account or `<provider>:<normalizedDir>`. */
export function buildAccountKey(provider: ProviderId, configDir?: string | null): string {
  const cleaned = configDir?.trim().replace(/\/+$/, '') ?? '';
  return cleaned ? `${provider}:${cleaned}` : provider;
}

export const TaskRoleSchema = z.enum(['lead', 'planner', 'engineer', 'qa', 'reviewer']);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const TaskComplexitySchema = z.enum(['low', 'medium', 'high']);
export type TaskComplexity = z.infer<typeof TaskComplexitySchema>;

export const TaskStatusSchema = z.enum([
  'draft',
  'needs_split',
  'ready',
  'approved',
  'running',
  'reviewing',
  'awaiting_merge',
  'review_failed',
  'done',
  'failed',
  'stopped',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RunStatusSchema = z.enum(['running', 'completed', 'failed', 'stopped', 'rolled_back']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunKindSchema = z.enum(['execute', 'fix', 'review']);
export type RunKind = z.infer<typeof RunKindSchema>;

/** Statuses a user may set by hand. `approved` is only reached through plan approval. */
export const EditableTaskStatusSchema = z.enum(['draft', 'needs_split', 'ready']);
export type EditableTaskStatus = z.infer<typeof EditableTaskStatusSchema>;

/** Roles a plan task can carry; routing rules match on these (PRD routing example). */
export const PlanTaskRoleSchema = z.enum(['engineer', 'qa']);
export type PlanTaskRole = z.infer<typeof PlanTaskRoleSchema>;

/** Whether a task modifies project files (`files`) or returns a standalone markdown answer (`answer`). */
export const TaskOutputKindSchema = z.enum(['files', 'answer']);
export type TaskOutputKind = z.infer<typeof TaskOutputKindSchema>;

export const SessionPhaseSchema = z.enum(['discuss', 'agree', 'list', 'run']);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

export const SessionModeSchema = z.enum(['auto', 'ask', 'quick', 'full']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SessionWorkStateSchema = z.enum(['idle', 'working']);
export type SessionWorkState = z.infer<typeof SessionWorkStateSchema>;

export const ModeSuggestionSchema = z.object({
  targetMode: z.enum(['quick', 'full']),
  reason: z.string().min(1),
});
export type ModeSuggestion = z.infer<typeof ModeSuggestionSchema>;

export const AskReplyContractSchema = z.object({
  answer: z.string().min(1),
  suggested_mode: z.enum(['quick', 'full']).nullable().optional(),
  suggestion_reason: z.string().nullable().optional(),
});
export type AskReplyContract = z.infer<typeof AskReplyContractSchema>;

/**
 * Structured question round written by Lead to `.dalang/discuss/round-N.json`.
 */
export const QuestionItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
  kind: z.enum(['single', 'multi', 'text']).default('single'),
  options: z.array(z.string()).default([]),
  allow_custom: z.boolean().default(true),
});
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

export const DiscussRoundSchema = z.object({
  round: z.number().int().min(1),
  summary: z.string().optional(),
  ready_for_brief: z.boolean().default(false),
  questions: z.array(QuestionItemSchema).default([]),
});
export type DiscussRound = z.infer<typeof DiscussRoundSchema>;

/**
 * Project brief written by Lead to `.dalang/brief.v{n}.json`.
 */
export const BriefContentSchema = z.object({
  version: z.number().int().min(1).default(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  scope: z.array(z.string()).min(1),
  features: z.array(z.string()).min(1),
  stack: z.array(z.string()).min(1),
  constraints: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
});
export type BriefContent = z.infer<typeof BriefContentSchema>;

/**
 * Plan & task schemas written by Lead to `.dalang/plan.json`.
 */
export const PlanMilestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
});
export type PlanMilestone = z.infer<typeof PlanMilestoneSchema>;

// Task ids become file names (split drafts, schema files), so they must be plain tokens.
export const TaskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'Task id must be letters, digits, "-" or "_"');

export const PlanTaskContractSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1),
  milestone: z.string().min(1),
  role: PlanTaskRoleSchema.default('engineer'),
  complexity: TaskComplexitySchema.default('low'),
  output: TaskOutputKindSchema.default('files'),
  depends_on: z.array(z.string()).default([]),
  goal: z.string().min(1),
  files_allowed: z.array(z.string()).default([]),
  files_reference: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).min(1),
  verify: z.string().nullable().optional(),
  needs_split: z.boolean().default(false),
  /** Executor profile name for this task; omitted means the routing rules pick one by complexity. */
  profile: z.string().trim().min(1).nullable().optional(),
});
export type PlanTaskContract = z.infer<typeof PlanTaskContractSchema>;

export const PlanContractSchema = z
  .object({
    version: z.number().int().min(1).default(1),
    brief_version: z.number().int().min(1).default(1),
    milestones: z.array(PlanMilestoneSchema).min(1),
    tasks: z.array(PlanTaskContractSchema).min(1),
    /** What prepares a fresh checkout, as the Lead read it from the repository. The user approves it before it runs. */
    setup_command: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });

    const milestoneIds = new Set<string>();
    for (const m of plan.milestones) {
      if (milestoneIds.has(m.id)) issue(`Duplicate milestone id "${m.id}"`);
      milestoneIds.add(m.id);
    }

    const taskIds = new Set<string>();
    for (const t of plan.tasks) {
      if (taskIds.has(t.id)) issue(`Duplicate task id "${t.id}"`);
      taskIds.add(t.id);
    }

    for (const t of plan.tasks) {
      if (!milestoneIds.has(t.milestone)) {
        issue(`Task ${t.id} references unknown milestone "${t.milestone}"`);
      }
      for (const dep of t.depends_on) {
        if (dep === t.id) issue(`Task ${t.id} depends on itself`);
        else if (!taskIds.has(dep)) issue(`Task ${t.id} depends on unknown task "${dep}"`);
      }
    }

    const edges = new Map(plan.tasks.map((t) => [t.id, t.depends_on]));
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string): boolean => {
      if (state.get(id) === 'done') return false;
      if (state.get(id) === 'visiting') return true;
      state.set(id, 'visiting');
      for (const dep of edges.get(id) ?? []) {
        if (edges.has(dep) && visit(dep)) return true;
      }
      state.set(id, 'done');
      return false;
    };
    if (plan.tasks.some((t) => visit(t.id))) issue('Task dependencies contain a cycle');
  });
export type PlanContract = z.infer<typeof PlanContractSchema>;

/**
 * Task execution result written by Executor to `.dalang/tasks/{id}/result.json`.
 */
export const TaskResultContractSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['completed', 'blocked', 'failed']),
  changed_files: z.array(z.string()).default([]),
  summary: z.string().min(1),
  answer: z.string().optional(),
  notes: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  verify_command: z.string().nullable().optional(),
  verify_exit_code: z.number().int().nullable().optional(),
  /** Files outside files_allowed the task cannot finish without; set with status "blocked". */
  needs_files: z.array(z.string()).optional(),
});
export type TaskResultContract = z.infer<typeof TaskResultContractSchema>;

/**
 * Task review written by Reviewer to `.dalang/tasks/{id}/review.json`.
 */
export const ReviewFindingSeveritySchema = z.enum(['critical', 'major', 'minor', 'info']);
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;

export const ReviewFindingSchema = z.object({
  severity: ReviewFindingSeveritySchema.default('major'),
  file: z.string().default(''),
  note: z.string().min(1),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewContractSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['pass', 'fail']),
  verify_exit_code: z.number().int().nullable().optional(),
  summary: z.string().optional(),
  findings: z.array(ReviewFindingSchema).default([]),
  /** What the reviewer could not check, such as how a page looks. The user sees it before merging. */
  unverified: z.array(z.string()).default([]),
});
export type ReviewContract = z.infer<typeof ReviewContractSchema>;

/**
 * Split subtask response when Lead splits a task with `needs_split: true`.
 */
export const TaskSplitOutputSchema = z.object({
  parent_task_id: z.string().min(1),
  subtasks: z.array(PlanTaskContractSchema).min(2),
});
export type TaskSplitOutput = z.infer<typeof TaskSplitOutputSchema>;

/**
 * Quick-mode mini-plan written by Lead to `.dalang/sessions/<id>/tmp/quick-plan-v{n}.json`.
 * Either a single concrete task ready to run, or a `too_large` judgment suggesting Full mode.
 */
export const QuickPlanContractSchema = z
  .object({
    verdict: z.enum(['ready', 'too_large']),
    summary: z.string().min(1),
    reason: z.string().optional(),
    findings: z.array(z.string()).default([]),
    task: PlanTaskContractSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.verdict === 'ready') {
      if (!val.task) {
        ctx.addIssue({
          code: 'custom',
          message: 'A "ready" quick plan must include a single "task" object.',
        });
      } else if (val.task.needs_split) {
        ctx.addIssue({
          code: 'custom',
          message: 'If the work needs splitting into multiple tasks, set verdict to "too_large".',
        });
      }
    }
    if (val.verdict === 'too_large' && !val.reason?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'A "too_large" verdict must include a non-empty "reason".',
      });
    }
  });
export type QuickPlanContract = z.infer<typeof QuickPlanContractSchema>;

/**
 * Provider status and usage window shapes.
 */
export const UsageWindowSchema = z.object({
  group: z.string(),
  window: z.string(),
  label: z.string(),
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  resetsAt: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export const ProviderUsageSchema = z.object({
  available: z.boolean(),
  windows: z.array(UsageWindowSchema),
  rawText: z.string().optional(),
  error: z.string().optional(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const ProviderModelVariantSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
});
export type ProviderModelVariant = z.infer<typeof ProviderModelVariantSchema>;

export const ProviderModelInfoSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
  resolvedModel: z.string().nullable().default(null),
  displayName: z.string().min(1),
  description: z.string().default(''),
  supportedEffortLevels: z.array(EffortLevelSchema).default([]),
  defaultEffort: EffortLevelSchema.nullable().default(null),
  supportsFastMode: z.boolean().default(false),
  supportsThinking: z.boolean().default(false),
  variants: z.array(ProviderModelVariantSchema).default([]),
});
export type ProviderModelInfo = z.infer<typeof ProviderModelInfoSchema>;

export const ProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string(),
  binary: z.string(),
  binaryPath: z.string().nullable(),
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
  authSummary: z.string(),
  sandboxReady: z.boolean(),
  sandboxEngine: SandboxEngineSchema.default('none'),
  models: z.array(ProviderModelInfoSchema),
  usage: ProviderUsageSchema,
  checkedAt: z.string(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

/**
 * API Request/Response DTOs
 */
export const CreateOrOpenProjectInputSchema = z.object({
  mode: z.enum(['create', 'open']),
  name: z.string().min(1).max(120).optional(),
  path: z.string().min(1),
  stackHint: z.string().optional(),
  initGitIfMissing: z.boolean().default(false),
  leadProvider: ProviderIdSchema.optional(),
  leadModel: z.string().optional(),
});
export type CreateOrOpenProjectInput = z.infer<typeof CreateOrOpenProjectInputSchema>;

export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_CHAT_IMAGES = 3;
export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;
export const CHAT_BODY_LIMIT = MAX_CHAT_IMAGES * 4 * Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) + 1024 * 1024;

const ChatImageSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.enum(CHAT_IMAGE_TYPES),
  data: z.string().min(1).max(4 * Math.ceil(MAX_CHAT_IMAGE_BYTES / 3)),
});
export type ChatImage = z.infer<typeof ChatImageSchema>;

export interface ChatImageMessage {
  text: string;
  images: Array<{ id: string; name: string }>;
}

export const DiscussMessageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        question: z.string(),
        selectedOptions: z.array(z.string()).default([]),
        customText: z.string().default(''),
      }),
    )
    .optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  /** Reasoning effort for this turn; the Lead's usual effort applies when omitted. */
  effort: EffortLevelSchema.optional(),
});
export type DiscussMessageInput = z.infer<typeof DiscussMessageInputSchema>;

export const CreateSessionInputSchema = z.object({
  mode: SessionModeSchema.default('auto'),
  title: z.string().trim().max(160).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().nullable().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const UpdateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  archived: z.boolean().optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().nullable().optional(),
});
export type UpdateSessionInput = z.infer<typeof UpdateSessionInputSchema>;

export const SwitchSessionModeInputSchema = z.object({
  mode: SessionModeSchema,
});
export type SwitchSessionModeInput = z.infer<typeof SwitchSessionModeInputSchema>;

export const ChatMessageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  mode: SessionModeSchema.default('auto'),
  message: z.string(),
  images: z.array(ChatImageSchema).max(MAX_CHAT_IMAGES).optional(),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        question: z.string(),
        selectedOptions: z.array(z.string()).default([]),
        customText: z.string().default(''),
      }),
    )
    .optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().nullable().optional(),
  /** Reasoning effort for this turn; the Lead's usual effort applies when omitted. */
  effort: EffortLevelSchema.optional(),
}).refine((input) => input.message.trim() || input.images?.length, {
  message: 'Enter a message or attach an image.',
  path: ['message'],
});
export type ChatMessageInput = z.infer<typeof ChatMessageInputSchema>;

export const QuickRunInputSchema = z.object({
  allowUnconfined: z.boolean().default(false),
});
export type QuickRunInput = z.infer<typeof QuickRunInputSchema>;

export const BriefReviseInputSchema = z.object({
  note: z.string().min(1),
});
export type BriefReviseInput = z.infer<typeof BriefReviseInputSchema>;

const TaskBaseFieldsSchema = z.object({
  title: z.string().min(1),
  milestone: z.string().min(1),
  role: PlanTaskRoleSchema,
  complexity: TaskComplexitySchema,
  output: TaskOutputKindSchema,
  dependsOn: z.array(z.string()),
  goal: z.string().min(1),
  filesAllowed: z.array(z.string()),
  filesReference: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).min(1),
  verify: z.string().nullable(),
  needsSplit: z.boolean(),
  status: EditableTaskStatusSchema,
  profileOverride: z.string().nullable(),
});

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1),
  milestone: z.string().min(1),
  role: PlanTaskRoleSchema.default('engineer'),
  complexity: TaskComplexitySchema.default('low'),
  output: TaskOutputKindSchema.optional(),
  dependsOn: z.array(z.string()).default([]),
  goal: z.string().min(1),
  filesAllowed: z.array(z.string()).default([]),
  filesReference: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
  verify: z.string().nullable().optional().default(null),
  needsSplit: z.boolean().default(false),
  status: EditableTaskStatusSchema.default('ready'),
  profileOverride: z.string().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

// Keep omitted PATCH fields undefined instead of re-applying Create defaults.
export const UpdateTaskInputSchema = TaskBaseFieldsSchema.partial();
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const ReorderTasksInputSchema = z.object({
  updates: z.array(
    z.object({
      id: z.string().min(1),
      status: EditableTaskStatusSchema.optional(),
      position: z.number().int().min(0),
    }),
  ),
});
export type ReorderTasksInput = z.infer<typeof ReorderTasksInputSchema>;

/** A Lead turn that is running right now, so any client that opens the chat can show it. */
export interface SessionTurnDTO {
  phase: string;
  provider: ProviderId;
  startedAt: string;
}

export interface SessionSummaryDTO {
  id: string;
  projectId: string;
  title: string;
  mode: SessionMode;
  workState: SessionWorkState;
  phase: SessionPhase;
  provider: ProviderId;
  model: string | null;
  cliSessionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestBriefStatus: 'none' | 'draft' | 'approved';
  latestBriefVersion: number | null;
  planStatus: 'none' | 'draft' | 'approved';
  taskCount: number;
  doneTaskCount: number;
  messageCount: number;
  /** Set while the Lead is answering in this session, otherwise null. */
  turn: SessionTurnDTO | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  mainBranch: string;
  leadProvider: ProviderId;
  leadModel: string | null;
  integrationCommand: string | null;
  pushAfterMerge: boolean;
  createPrAfterMerge: boolean;
  gitRemote: string | null;
  createdAt: string;
  updatedAt: string;
  hasProjectMd: boolean;
  symlinksValid: {
    claudeMd: boolean;
    agentsMd: boolean;
  };
  latestBriefStatus: 'none' | 'draft' | 'approved';
  latestBriefVersion: number | null;
  taskCount: number;
  planStatus: 'none' | 'draft' | 'approved';
  sessionCount: number;
  workingSessionId: string | null;
  workingSessionTitle: string | null;
}

export const MessageKindSchema = z.enum(['chat', 'report', 'question', 'gate', 'status']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export type SessionMessageType =
  | 'text'
  | 'images'
  | 'ask'
  | 'questions'
  | 'quick_plan'
  | 'brief'
  | 'plan'
  | 'report'
  | 'error';

export type RoomReportEvent =
  | 'auto_resume_failed'
  | 'run_finished'
  | 'run_stopped'
  | 'merge_conflict'
  | 'setup_result'
  | 'scope_request'
  | 'task_started'
  | 'task_finished'
  | 'task_failed'
  | 'verify_result'
  | 'review_verdict'
  | 'task_merged'
  | 'task_accepted'
  | 'task_rejected'
  | 'task_steered'
  | 'task_waiting'
  | 'integration_result';

export interface RoomReportContent {
  event: RoomReportEvent;
  taskId?: string;
  externalId?: string;
  taskTitle?: string;
  output?: TaskOutputKind;
  summary: string;
  answer?: string;
  answerPath?: string;
  profileName?: string;
  provider?: ProviderId;
  model?: string | null;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  verifyCommand?: string | null;
  verifyExitCode?: number | null;
  verifySkipped?: boolean;
  reviewStatus?: 'pass' | 'fail';
  reviewRound?: number;
  findingsCount?: number;
  findings?: Array<{ severity: ReviewFindingSeverity; file: string; note: string }>;
  mergeCommitSha?: string;
  /** For `review_verdict`: what the reviewer could not check. */
  unverified?: string[];
  /** For `scope_request`: files outside the task's files_allowed that it needs. */
  needsFiles?: string[];
  /** For `run_finished` and `run_stopped`: task counts and the external IDs of tasks left behind. */
  outcome?: { done: number; total: number; reviewFailed: string[]; failed: string[]; waiting: string[] };
}

export interface RoomRouteInfo {
  kind: 'lead' | 'ask' | 'steer';
  profileId: string | null;
  profileName: string;
  taskId?: string;
  runId?: string;
}

export interface AskMessageContent {
  text: string;
  suggestion: ModeSuggestion | null;
}

export interface QuickPlanMessageContent {
  verdict: 'ready' | 'too_large';
  summary: string;
  reason?: string;
  findings?: string[];
  planId?: string;
  planVersion?: number;
  task?: PlanTaskContract;
  taskId?: string;
}

export interface DiscussMessageDTO {
  id: string;
  sessionId: string;
  role: 'user' | 'lead' | 'agent' | 'system';
  type: SessionMessageType;
  kind?: MessageKind;
  authorProfileId?: string | null;
  authorProfileName?: string | null;
  content: unknown;
  createdAt: string;
}

export interface BriefDTO {
  id: string;
  projectId: string;
  sessionId: string;
  version: number;
  status: 'draft' | 'approved';
  filePath: string;
  content: BriefContent;
  createdAt: string;
  approvedAt: string | null;
}

export interface TaskDTO {
  id: string;
  planId: string;
  externalId: string;
  title: string;
  milestone: string;
  role: PlanTaskRole;
  complexity: TaskComplexity;
  output: TaskOutputKind;
  status: TaskStatus;
  position: number;
  goal: string;
  filesAllowed: string[];
  filesReference: string[];
  acceptanceCriteria: string[];
  verify: string | null;
  needsSplit: boolean;
  splitDepth: number;
  parentTaskId: string | null;
  delegatedByRunId: string | null;
  delegationDepth: number;
  mergeTargetBranch: string | null;
  profileOverride: string | null;
  reviewRounds: number;
  branchName: string | null;
  mergeCommitSha: string | null;
  rejectionNote: string | null;
  prUrl: string | null;
  pushedAt: string | null;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanDTO {
  id: string;
  projectId: string;
  sessionId: string;
  briefId: string | null;
  version: number;
  status: 'draft' | 'approved';
  filePath: string;
  milestones: PlanMilestone[];
  tasks: TaskDTO[];
  createdAt: string;
  approvedAt: string | null;
}

export interface SessionDetailDTO {
  session: SessionSummaryDTO;
  messages: DiscussMessageDTO[];
  currentRound: number;
  briefs: BriefDTO[];
  plan: PlanDTO | null;
}

export const PermissionModeSchema = z.enum(['workspace-write', 'read-only', 'accept-edits']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export interface AgentProfileDTO {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  effort: EffortLevel;
  rolePrompt: string;
  permissionMode: PermissionMode;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxParallel: number;
  maxReviewRounds: number;
  fallback: FallbackTarget | null;
  configDir: string | null;
  isDefault: boolean;
  createdAt: string;
}

/** `gemini-4-neon-high` becomes `{ base: 'gemini-4-neon', level: 'high' }`; null when the id has no level suffix. */
export function splitEffortModel(model: string): { base: string; level: EffortLevel } | null {
  const m = model.trim().match(/^(.+)-(low|medium|high|xhigh|max)$/i);
  return m ? { base: m[1], level: m[2].toLowerCase() as EffortLevel } : null;
}

/**
 * Where work goes when the primary CLI cannot run it: another CLI, model, and effort. It is not a
 * profile, so the fallback run keeps the primary profile's role instructions and limits.
 */
export const FallbackTargetSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().trim().max(120),
  effort: EffortLevelSchema,
  /** A second account of the same CLI (its config directory), or null for the default account. */
  configDir: z.string().trim().max(500).nullable(),
});
export type FallbackTarget = z.infer<typeof FallbackTargetSchema>;

/** The most review rounds a task may run before it stops and asks the user. */
export const MAX_REVIEW_ROUNDS = 6;

const ProfileBaseFieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Profile name must use letters, digits, ".", "-" or "_"'),
  provider: ProviderIdSchema,
  model: z.string().trim().max(120),
  effort: EffortLevelSchema,
  rolePrompt: z.string().max(4000),
  permissionMode: PermissionModeSchema,
  timeoutMs: z.number().int().min(5000).max(7_200_000),
  idleTimeoutMs: z.number().int().min(5000).max(3_600_000),
  maxParallel: z.number().int().min(1).max(16),
  maxReviewRounds: z.number().int().min(1).max(MAX_REVIEW_ROUNDS),
  fallback: FallbackTargetSchema.nullable(),
  configDir: z.string().trim().max(500).nullable(),
});

export const CreateProfileInputSchema = z.object({
  name: ProfileBaseFieldsSchema.shape.name,
  provider: ProviderIdSchema,
  model: ProfileBaseFieldsSchema.shape.model.default(''),
  effort: EffortLevelSchema.default('medium'),
  rolePrompt: ProfileBaseFieldsSchema.shape.rolePrompt.default(''),
  permissionMode: PermissionModeSchema.default('workspace-write'),
  timeoutMs: ProfileBaseFieldsSchema.shape.timeoutMs.default(1_800_000),
  idleTimeoutMs: ProfileBaseFieldsSchema.shape.idleTimeoutMs.default(180_000),
  maxParallel: ProfileBaseFieldsSchema.shape.maxParallel.default(1),
  maxReviewRounds: ProfileBaseFieldsSchema.shape.maxReviewRounds.default(2),
  fallback: ProfileBaseFieldsSchema.shape.fallback.default(null),
  configDir: ProfileBaseFieldsSchema.shape.configDir.default(null),
});
export type CreateProfileInput = z.infer<typeof CreateProfileInputSchema>;

export const UpdateProfileInputSchema = ProfileBaseFieldsSchema.partial();
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;

const RoutingRuleBaseFieldsSchema = z.object({
  role: TaskRoleSchema,
  complexity: TaskComplexitySchema.nullable(),
  profileId: z.string().min(1),
  fallback: FallbackTargetSchema.nullable(),
});

export const CreateRoutingRuleInputSchema = z.object({
  role: TaskRoleSchema,
  complexity: TaskComplexitySchema.nullable().default(null),
  profileId: z.string().min(1),
  fallback: FallbackTargetSchema.nullable().default(null),
});
export type CreateRoutingRuleInput = z.infer<typeof CreateRoutingRuleInputSchema>;

export const UpdateRoutingRuleInputSchema = RoutingRuleBaseFieldsSchema.partial();
export type UpdateRoutingRuleInput = z.infer<typeof UpdateRoutingRuleInputSchema>;

export const ReorderRoutingRulesInputSchema = z.object({
  ruleIds: z.array(z.string().min(1)).min(1),
});
export type ReorderRoutingRulesInput = z.infer<typeof ReorderRoutingRulesInputSchema>;

const SetupCommandSchema = z.string().trim().max(4000).nullable().transform((v) => v || null);
export const WorkspaceSetupConfigSchema = z.object({
  /** Runs in each new task worktree. Null keeps DALANG's built-in JavaScript install. */
  command: SetupCommandSchema,
  /** Runs instead of `command` after a snapshot was restored. */
  maintenanceCommand: SetupCommandSchema.default(null),
  /**
   * The project's own check (its CI command), run with each task's verify before review and merge (B32).
   * Absent means the user has not decided yet; null means none.
   */
  checkCommand: z.string().trim().max(4000).nullable().transform((v) => v || null).optional(),
  /** Git-ignored local files copied from the project into each task worktree. */
  files: z.array(z.string().trim().min(1)).max(50).default([]),
});
export type WorkspaceSetupConfig = z.infer<typeof WorkspaceSetupConfigSchema>;

export interface WorkspaceSetupProposal {
  command: string | null;
  maintenanceCommand: string | null;
  checkCommand: string | null;
  source: string;
  files: string[];
  warnings: string[];
}

export interface WorkspaceSetupDTO {
  /** What the user decided, or null when they have not decided yet. */
  approved: WorkspaceSetupConfig | null;
  proposal: WorkspaceSetupProposal | null;
  needsApproval: boolean;
  warnings: string[];
  hasSnapshot: boolean;
}

export const ContinueTaskInputSchema = z.object({
  note: z.string().trim().max(4000).optional(),
  allowUnconfined: z.boolean().default(false),
});
export type ContinueTaskInput = z.infer<typeof ContinueTaskInputSchema>;

export const AllowTaskScopeInputSchema = z.object({
  files: z.array(z.string().trim().min(1)).min(1),
  allowUnconfined: z.boolean().default(false),
});
export type AllowTaskScopeInput = z.infer<typeof AllowTaskScopeInputSchema>;

export const StartExecutionInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  allowUnconfined: z.boolean().default(false),
  resumeSession: z.boolean().default(false),
});
export type StartExecutionInput = z.infer<typeof StartExecutionInputSchema>;

export const StopExecutionInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});
export type StopExecutionInput = z.infer<typeof StopExecutionInputSchema>;

export const ProviderEventTypeSchema = z.enum([
  'rate_limit',
  'login_expired',
  'timeout',
  'error',
  'quota_fallback',
]);
export type ProviderEventType = z.infer<typeof ProviderEventTypeSchema>;

export const AssignTaskProfileInputSchema = z.object({
  profileOverride: z.string().min(1).nullable(),
});
export type AssignTaskProfileInput = z.infer<typeof AssignTaskProfileInputSchema>;

export const RejectTaskInputSchema = z.object({
  note: z.string().trim().max(2000).default(''),
  requeue: z.boolean().default(false),
});
export type RejectTaskInput = z.infer<typeof RejectTaskInputSchema>;

export const ApproveMergeInputSchema = z.object({
  allowUnconfined: z.boolean().default(false),
  runIntegration: z.boolean().default(true),
  allowFailedReview: z.boolean().default(false),
  pushAfterMerge: z.boolean().optional(),
  createPrAfterMerge: z.boolean().optional(),
});
export type ApproveMergeInput = z.infer<typeof ApproveMergeInputSchema>;

export const PushPrInputSchema = z.object({
  remote: z.string().trim().min(1).max(100).optional(),
  createPr: z.boolean().default(true),
});
export type PushPrInput = z.infer<typeof PushPrInputSchema>;

export interface PushPrRepoResultDTO {
  repoPath: string;
  remote: string;
  branch: string;
  prUrl: string | null;
}

export interface PushPrResultDTO {
  pushed: boolean;
  remote: string;
  branch: string;
  prUrl: string | null;
  message: string;
  repos?: PushPrRepoResultDTO[];
}

export const RunIntegrationInputSchema = z.object({
  command: z.string().trim().min(1).max(500).optional(),
  allowUnconfined: z.boolean().default(false),
});
export type RunIntegrationInput = z.infer<typeof RunIntegrationInputSchema>;

/** How often the provider limits bar asks the CLIs for fresh numbers, in minutes. */
export const USAGE_REFRESH_OPTIONS = [3, 5, 10] as const;
export const DEFAULT_USAGE_REFRESH_MINUTES = 5;
export const UsageRefreshMinutesSchema = z.union([z.literal(3), z.literal(5), z.literal(10)]);
export type UsageRefreshMinutes = z.infer<typeof UsageRefreshMinutesSchema>;

export const UpdateSettingsInputSchema = z.object({
  antigravityKeyringAccess: z.boolean().optional(),
  language: UiLanguageSchema.optional(),
  checkForUpdates: z.boolean().optional(),
  usageRefreshMinutes: UsageRefreshMinutesSchema.optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

export interface SettingsDTO {
  /** Lets sandboxed Antigravity runs read the whole desktop keyring. Off by default. */
  antigravityKeyringAccess: boolean;
  /** Preferred UI and agent output language. Null until the user or browser sets one. */
  language: UiLanguage | null;
  /** Whether DALANG checks npm registry once per 24h for a newer version. On by default. */
  checkForUpdates: boolean;
  /** Minutes between automatic refreshes of the provider limits while the page is open. Default 5. */
  usageRefreshMinutes: UsageRefreshMinutes;
}

export interface AuthStatusDTO {
  enabled: boolean;
  authenticated: boolean;
  language: UiLanguage | null;
}

export interface UpdateStatusDTO {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  checkEnabled: boolean;
  releaseNotesUrl: string;
}

export type ProviderCliUpdateStatus = 'updated' | 'failed' | 'skipped';

export interface ProviderCliUpdateResultDTO {
  provider: ProviderId;
  displayName: string;
  binary: string;
  status: ProviderCliUpdateStatus;
  beforeVersion: string | null;
  afterVersion: string | null;
  message: string;
}

export interface RoutingRuleDTO {
  id: string;
  sortOrder: number;
  role: TaskRole;
  complexity: TaskComplexity | null;
  profileId: string;
  profileName: string;
  fallback: FallbackTarget | null;
}

export interface TaskDispatchPreviewDTO {
  taskId: string;
  externalId: string;
  title: string;
  milestone: string;
  role: PlanTaskRole;
  complexity: TaskComplexity;
  status: TaskStatus;
  parentTaskId: string | null;
  delegatedByRunId: string | null;
  delegationDepth: number;
  dependsOn: string[];
  wave: number;
  overlappingTasks: string[];
  blockedByOverlapWith: string | null;
  dependenciesSatisfied: boolean;
  eligible: boolean;
  blockedReason: string | null;
  resolvedProfileId: string;
  resolvedProfileName: string;
  resolvedProvider: ProviderId;
  resolvedModel: string;
  /** The CLI, model, and effort used when the routed one cannot run, or null when none is set. */
  fallback: FallbackTarget | null;
  selectionSource: 'override' | 'routing_rule' | 'default';
  /** Set when the routed profile cannot run as configured and another one is used instead. */
  selectionNote: string | null;
  quotaReroutedReason: string | null;
}

export interface TaskRunDTO {
  canSteer?: boolean;
  id: string;
  projectId: string;
  taskId: string;
  taskExternalId: string;
  taskTitle: string;
  parentTaskId?: string | null;
  delegationDepth?: number;
  profileId: string;
  profileName: string;
  provider: ProviderId;
  accountKey: string;
  model: string | null;
  kind: RunKind;
  branchName: string | null;
  worktreePath: string | null;
  status: RunStatus;
  cliSessionId: string | null;
  attempt: number;
  usedFallback: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  failureReason: string | null;
  commitBefore: string | null;
  commitAfter: string | null;
  checkpointBeforeRef: string | null;
  checkpointAfterRef: string | null;
  logPath: string;
  resultPath: string | null;
  result: TaskResultContract | null;
  scopeWarnings: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedCostUsd: number | null;
  costSource: 'cli' | 'estimated' | null;
}

export interface TaskReviewDTO {
  id: string;
  projectId: string;
  taskId: string;
  taskExternalId: string;
  taskTitle: string;
  runId: string;
  round: number;
  status: 'pass' | 'fail';
  humanDecision: 'pending' | 'approved' | 'rejected';
  humanNote: string | null;
  reviewerProfileId: string;
  reviewerProfileName: string;
  reviewerProvider: ProviderId;
  reviewerModel: string | null;
  verifyCommand: string | null;
  verifyExitCode: number | null;
  verifyOutput: string;
  filePath: string;
  commitSha: string | null;
  contract: ReviewContract;
  scopeWarnings: string[];
  createdAt: string;
  decidedAt: string | null;
}

export interface TaskDiffFileDTO {
  path: string;
  repo?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}

export interface TaskRepoDiffSummaryDTO {
  repoPath: string;
  baseBranch: string;
  branchName: string | null;
  baseCommitSha: string | null;
  headCommitSha: string | null;
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface TaskDiffDTO {
  taskId: string;
  externalId: string;
  output?: TaskOutputKind;
  answer?: string | null;
  answerPath?: string | null;
  branchName: string | null;
  baseCommitSha: string | null;
  headCommitSha: string | null;
  files: TaskDiffFileDTO[];
  repos?: TaskRepoDiffSummaryDTO[];
  rawDiff: string;
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
}

export interface IntegrationRunDTO {
  id: string;
  projectId: string;
  taskId: string | null;
  taskExternalId: string | null;
  mergeCommitSha: string | null;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string;
}

export interface GuardTaskEntryDTO {
  task: TaskDTO;
  latestRun: TaskRunDTO | null;
  reviews: TaskReviewDTO[];
  latestReview: TaskReviewDTO | null;
  diffAvailable: boolean;
  answer?: string | null;
  answerPath?: string | null;
  canApproveMerge: boolean;
  canReject: boolean;
}

export interface GuardStateDTO {
  projectId: string;
  sessionId: string | null;
  mainBranch: string;
  integrationCommand: string | null;
  detectedIntegrationCommand: string | null;
  pushAfterMerge: boolean;
  createPrAfterMerge: boolean;
  gitRemote: string | null;
  ghAvailable: boolean;
  sandboxReady: boolean;
  sandboxEngine: SandboxEngine;
  platform: string;
  tasks: GuardTaskEntryDTO[];
  integrationRuns: IntegrationRunDTO[];
}

export interface ProviderRuntimeStateDTO {
  provider: ProviderId;
  accountKey: string;
  configDir: string | null;
  activeCount: number;
  maxParallel: number;
  inCooldown: boolean;
  cooldownReason: string | null;
  cooldownUntil: string | null;
  quotaExhausted: boolean;
  quotaReason: string | null;
}

export interface ProviderEventDTO {
  id: string;
  provider: ProviderId;
  accountKey: string;
  type: ProviderEventType;
  detail: string | null;
  createdAt: string;
}

export interface ModelUsageStatisticsDTO {
  provider: ProviderId;
  model: string;
  totalRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  estimatedCostUsd: number;
  costIsEstimated: boolean;
}

export interface ProviderStatisticsDTO {
  provider: ProviderId;
  displayName: string;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  stoppedRuns: number;
  runningRuns: number;
  rolledBackRuns: number;
  fallbackRuns: number;
  byKind: {
    lead: number;
    execute: number;
    fix: number;
    review: number;
  };
  totalDurationMs: number;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  estimatedCostUsd: number;
  rateLimitEvents: number;
  timeoutEvents: number;
  loginExpiredEvents: number;
  errorEvents: number;
  quotaFallbackEvents: number;
  lastEventAt: string | null;
  lastEventDetail: string | null;
  activeRuns: number;
  maxParallel: number;
  inCooldown: boolean;
  cooldownReason: string | null;
  cooldownUntil: string | null;
  quotaExhausted: boolean;
  quotaReason: string | null;
}

export interface ProjectUsageStatisticsDTO {
  projectId: string;
  projectName: string;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  fallbackRuns: number;
  totalDurationMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface UsageStatisticsResponseDTO {
  generatedAt: string;
  projectId: string | null;
  windowDays: number | null;
  totals: {
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    fallbackRuns: number;
    totalDurationMs: number;
    rateLimitEvents: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cacheHitRate: number | null;
    estimatedCostUsd: number;
  };
  providers: ProviderStatisticsDTO[];
  models: ModelUsageStatisticsDTO[];
  projects: ProjectUsageStatisticsDTO[];
  recentEvents: ProviderEventDTO[];
}

export interface ExecutionStateDTO {
  projectId: string;
  sessionId: string | null;
  planStatus: 'none' | 'draft' | 'approved';
  activeRun: TaskRunDTO | null;
  activeRuns: TaskRunDTO[];
  queueRunning: boolean;
  sandboxReady: boolean;
  sandboxEngine: SandboxEngine;
  platform: string;
  providerStates: ProviderRuntimeStateDTO[];
  dispatchPreviews: TaskDispatchPreviewDTO[];
  runs: TaskRunDTO[];
}

/**
 * v0.8 Agent Delegation MCP tool schemas & DTOs
 */
export const DelegateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  profile: z.string().trim().min(1).max(100).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(120).optional(),
  effort: EffortLevelSchema.optional(),
  files_allowed: z.array(z.string().trim().min(1)).optional(),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  verify: z.string().trim().min(1).max(500).nullable().optional(),
  mode: z.enum(['wait', 'async']).default('wait'),
  client_request_id: z.string().trim().min(1).max(128).optional(),
});
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;

export const TaskStatusInputSchema = z.object({
  task_id: z.string().trim().min(1),
});
export type TaskStatusInput = z.infer<typeof TaskStatusInputSchema>;

export const TaskCancelInputSchema = z.object({
  task_id: z.string().trim().min(1),
});
export type TaskCancelInput = z.infer<typeof TaskCancelInputSchema>;

export interface DelegatedSubtaskStatusDTO {
  task_id: string;
  external_id: string;
  parent_task_id: string;
  client_request_id?: string | null;
  title: string;
  status: TaskStatus;
  provider: ProviderId;
  model: string | null;
  profile: string;
  branch_name: string | null;
  merge_target_branch: string | null;
  merged_into_parent: boolean;
  merge_commit_sha: string | null;
  files_allowed: string[];
  verify: string | null;
  review_status: 'pass' | 'fail' | null;
  review_rounds: number;
  review_findings: ReviewFinding[];
  summary: string | null;
  changed_files: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * v0.11 Automation (scheduled & webhook-triggered runs) and Outside Agents over MCP
 */
export const AutomationKindSchema = z.enum(['schedule', 'webhook']);
export type AutomationKind = z.infer<typeof AutomationKindSchema>;

export const AutomationTriggerSourceSchema = z.enum(['schedule', 'webhook', 'manual']);
export type AutomationTriggerSource = z.infer<typeof AutomationTriggerSourceSchema>;

export const AutomationRunStatusSchema = z.enum([
  'running',
  'awaiting_merge',
  'completed',
  'failed',
  'review_failed',
  'skipped',
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const CreateAutomationInputSchema = z
  .object({
    projectId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    kind: AutomationKindSchema,
    enabled: z.boolean().default(true),
    cronExpr: z.string().trim().max(120).nullable().optional(),
    webhookSecret: z.string().trim().min(16).max(256).optional(),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    role: PlanTaskRoleSchema.default('engineer'),
    complexity: TaskComplexitySchema.default('low'),
    output: TaskOutputKindSchema.optional(),
    filesAllowed: z.array(z.string().trim().min(1)).default([]),
    filesReference: z.array(z.string().trim().min(1)).default([]),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).max(20),
    verify: z.string().trim().max(500).nullable().optional(),
    profileOverride: z.string().trim().min(1).nullable().optional(),
    allowUnconfined: z.boolean().default(false),
    autoMerge: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'schedule' && !val.cronExpr?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['cronExpr'],
        message: 'A cron expression is required for scheduled automations.',
      });
    }
  });
export type CreateAutomationInput = z.infer<typeof CreateAutomationInputSchema>;

export const UpdateAutomationInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  cronExpr: z.string().trim().min(1).max(120).nullable().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  role: PlanTaskRoleSchema.optional(),
  complexity: TaskComplexitySchema.optional(),
  output: TaskOutputKindSchema.optional(),
  filesAllowed: z.array(z.string().trim().min(1)).optional(),
  filesReference: z.array(z.string().trim().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  verify: z.string().trim().max(500).nullable().optional(),
  profileOverride: z.string().trim().min(1).nullable().optional(),
  allowUnconfined: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
});
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationInputSchema>;

export const TriggerAutomationInputSchema = z.object({
  event: z.string().trim().max(120).optional(),
  payload: z.string().max(16_000).optional(),
});
export type TriggerAutomationInput = z.infer<typeof TriggerAutomationInputSchema>;

export interface AutomationDTO {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  kind: AutomationKind;
  enabled: boolean;
  cronExpr: string | null;
  webhookToken: string | null;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  title: string;
  prompt: string;
  role: PlanTaskRole;
  complexity: TaskComplexity;
  output: TaskOutputKind;
  filesAllowed: string[];
  filesReference: string[];
  acceptanceCriteria: string[];
  verify: string | null;
  profileOverride: string | null;
  allowUnconfined: boolean;
  autoMerge: boolean;
  lastTriggeredAt: string | null;
  nextRunAt: string | null;
  lastStatus: AutomationRunStatus | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedAutomationDTO extends AutomationDTO {
  /** Returned only once when a webhook automation is created or its secret is rotated. */
  webhookSecret?: string;
}

export interface AutomationRunDTO {
  id: string;
  automationId: string;
  projectId: string;
  triggerSource: AutomationTriggerSource;
  sessionId: string | null;
  taskId: string | null;
  status: AutomationRunStatus;
  detail: string | null;
  payloadExcerpt: string | null;
  triggeredAt: string;
  finishedAt: string | null;
}

export const McpAccessLevelSchema = z.enum(['read-only', 'full-access']);
export type McpAccessLevel = z.infer<typeof McpAccessLevelSchema>;

export const CreateMcpTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  accessLevel: McpAccessLevelSchema.default('read-only'),
  projectId: z.string().trim().min(1).nullable().optional(),
});
export type CreateMcpTokenInput = z.infer<typeof CreateMcpTokenInputSchema>;

export interface McpTokenDTO {
  id: string;
  name: string;
  accessLevel: McpAccessLevel;
  tokenPrefix: string;
  projectId: string | null;
  projectName: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedMcpTokenDTO {
  tokenInfo: McpTokenDTO;
  /** Raw bearer token returned only once at creation time. */
  token: string;
  endpointUrl: string | null;
}

/**
 * External MCP tool argument schemas (outside agents on loopback /mcp).
 */
export const ExternalMcpGetProjectInputSchema = z.object({
  project_id: z.string().trim().min(1),
});
export type ExternalMcpGetProjectInput = z.infer<typeof ExternalMcpGetProjectInputSchema>;

export const ExternalMcpListSessionsInputSchema = z.object({
  project_id: z.string().trim().min(1),
  include_archived: z.boolean().default(false),
});
export type ExternalMcpListSessionsInput = z.infer<typeof ExternalMcpListSessionsInputSchema>;

export const ExternalMcpListTasksInputSchema = z.object({
  project_id: z.string().trim().min(1),
  session_id: z.string().trim().min(1).optional(),
});
export type ExternalMcpListTasksInput = z.infer<typeof ExternalMcpListTasksInputSchema>;

export const ExternalMcpGetTaskInputSchema = z.object({
  project_id: z.string().trim().min(1),
  task_id: z.string().trim().min(1),
});
export type ExternalMcpGetTaskInput = z.infer<typeof ExternalMcpGetTaskInputSchema>;

export const ExternalMcpGetRunLogInputSchema = z.object({
  project_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  tail_lines: z.number().int().min(1).max(500).default(200),
});
export type ExternalMcpGetRunLogInput = z.infer<typeof ExternalMcpGetRunLogInputSchema>;

export const ExternalMcpListAutomationsInputSchema = z.object({
  project_id: z.string().trim().min(1).optional(),
});
export type ExternalMcpListAutomationsInput = z.infer<typeof ExternalMcpListAutomationsInputSchema>;

export const ExternalMcpStartTaskInputSchema = z.object({
  project_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(20_000),
  role: PlanTaskRoleSchema.default('engineer'),
  complexity: TaskComplexitySchema.default('low'),
  output: TaskOutputKindSchema.default('files'),
  files_allowed: z.array(z.string().trim().min(1)).default([]),
  files_reference: z.array(z.string().trim().min(1)).default([]),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  verify: z.string().trim().max(500).nullable().optional(),
  profile: z.string().trim().min(1).max(100).optional(),
  allow_unconfined: z.boolean().default(false),
  auto_merge: z.boolean().default(false),
  mode: z.enum(['wait', 'async']).default('wait'),
});
export type ExternalMcpStartTaskInput = z.infer<typeof ExternalMcpStartTaskInputSchema>;

export const ExternalMcpStopTaskInputSchema = z.object({
  project_id: z.string().trim().min(1),
  task_id: z.string().trim().min(1),
});
export type ExternalMcpStopTaskInput = z.infer<typeof ExternalMcpStopTaskInputSchema>;

export const ExternalMcpApproveMergeInputSchema = z.object({
  project_id: z.string().trim().min(1),
  task_id: z.string().trim().min(1),
  run_integration: z.boolean().default(true),
  allow_unconfined: z.boolean().default(false),
  allow_failed_review: z.boolean().default(false),
});
export type ExternalMcpApproveMergeInput = z.infer<typeof ExternalMcpApproveMergeInputSchema>;

export const ExternalMcpRejectTaskInputSchema = z.object({
  project_id: z.string().trim().min(1),
  task_id: z.string().trim().min(1),
  note: z.string().trim().max(2000).default(''),
  requeue: z.boolean().default(false),
});
export type ExternalMcpRejectTaskInput = z.infer<typeof ExternalMcpRejectTaskInputSchema>;

export const ExternalMcpTriggerAutomationInputSchema = z.object({
  automation_id: z.string().trim().min(1),
  event: z.string().trim().max(120).optional(),
  payload: z.string().max(16_000).optional(),
});
export type ExternalMcpTriggerAutomationInput = z.infer<typeof ExternalMcpTriggerAutomationInputSchema>;

/** Seeded profile names before schema v18, with the id of the profile each one named. */
export const LEGACY_PROFILE_NAMES: Readonly<Record<string, { id: string; name: string }>> = {
  'coder-small': { id: 'profile-coder-small', name: 'executor-light' },
  'coder-medium': { id: 'profile-coder-medium', name: 'executor-medium' },
  'coder-heavy': { id: 'profile-coder-heavy', name: 'executor-heavy' },
  qa: { id: 'profile-qa', name: 'checker' },
};

/**
 * Finds a profile by id or name. A name from before v18 (in a saved plan, an automation, an MCP call,
 * or a mention) finds the same seeded profile. A profile that really has that name wins.
 */
export function findProfileByRef<T extends { id: string; name: string }>(profiles: readonly T[], ref: string): T | undefined {
  const exact = profiles.find((p) => p.id === ref || p.name === ref);
  if (exact || !Object.hasOwn(LEGACY_PROFILE_NAMES, ref)) return exact;
  return profiles.find((p) => p.id === LEGACY_PROFILE_NAMES[ref].id);
}
