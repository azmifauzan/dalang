import { z } from 'zod';

export const ProviderIdSchema = z.enum(['claude-code', 'codex', 'antigravity']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const SandboxEngineSchema = z.enum(['bwrap', 'sandbox-exec', 'none']);
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

export const SessionPhaseSchema = z.enum(['discuss', 'agree', 'list', 'run']);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

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
  depends_on: z.array(z.string()).default([]),
  goal: z.string().min(1),
  files_allowed: z.array(z.string()).default([]),
  files_reference: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).min(1),
  verify: z.string().min(1),
  needs_split: z.boolean().default(false),
});
export type PlanTaskContract = z.infer<typeof PlanTaskContractSchema>;

export const PlanContractSchema = z
  .object({
    version: z.number().int().min(1).default(1),
    brief_version: z.number().int().min(1).default(1),
    milestones: z.array(PlanMilestoneSchema).min(1),
    tasks: z.array(PlanTaskContractSchema).min(1),
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
 * Task execution result written by Coder to `.dalang/tasks/{id}/result.json`.
 */
export const TaskResultContractSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['completed', 'blocked', 'failed']),
  changed_files: z.array(z.string()).default([]),
  summary: z.string().min(1),
  notes: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  verify_command: z.string().optional(),
  verify_exit_code: z.number().int().nullable().optional(),
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
  verify_exit_code: z.number().int(),
  summary: z.string().optional(),
  findings: z.array(ReviewFindingSchema).default([]),
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
  leadProvider: ProviderIdSchema.default('claude-code'),
  leadModel: z.string().optional(),
});
export type CreateOrOpenProjectInput = z.infer<typeof CreateOrOpenProjectInputSchema>;

export const DiscussMessageInputSchema = z.object({
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
});
export type DiscussMessageInput = z.infer<typeof DiscussMessageInputSchema>;

export const BriefReviseInputSchema = z.object({
  note: z.string().min(1),
});
export type BriefReviseInput = z.infer<typeof BriefReviseInputSchema>;

const TaskBaseFieldsSchema = z.object({
  title: z.string().min(1),
  milestone: z.string().min(1),
  role: PlanTaskRoleSchema,
  complexity: TaskComplexitySchema,
  dependsOn: z.array(z.string()),
  goal: z.string().min(1),
  filesAllowed: z.array(z.string()),
  filesReference: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).min(1),
  verify: z.string().min(1),
  needsSplit: z.boolean(),
  status: EditableTaskStatusSchema,
  profileOverride: z.string().nullable(),
});

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1),
  milestone: z.string().min(1),
  role: PlanTaskRoleSchema.default('engineer'),
  complexity: TaskComplexitySchema.default('low'),
  dependsOn: z.array(z.string()).default([]),
  goal: z.string().min(1),
  filesAllowed: z.array(z.string()).default([]),
  filesReference: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
  verify: z.string().min(1),
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
}

export interface DiscussMessageDTO {
  id: string;
  sessionId: string;
  role: 'user' | 'lead' | 'system';
  type: 'text' | 'questions' | 'brief' | 'plan' | 'error';
  content: unknown;
  createdAt: string;
}

export interface BriefDTO {
  id: string;
  projectId: string;
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
  status: TaskStatus;
  position: number;
  goal: string;
  filesAllowed: string[];
  filesReference: string[];
  acceptanceCriteria: string[];
  verify: string;
  needsSplit: boolean;
  splitDepth: number;
  parentTaskId: string | null;
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
  briefId: string;
  version: number;
  status: 'draft' | 'approved';
  filePath: string;
  milestones: PlanMilestone[];
  tasks: TaskDTO[];
  createdAt: string;
  approvedAt: string | null;
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
  fallbackProfileId: string | null;
  configDir: string | null;
  isDefault: boolean;
  createdAt: string;
}

/** `gemini-4-neon-high` becomes `{ base: 'gemini-4-neon', level: 'high' }`; null when the id has no level suffix. */
export function splitEffortModel(model: string): { base: string; level: EffortLevel } | null {
  const m = model.trim().match(/^(.+)-(low|medium|high|xhigh|max)$/i);
  return m ? { base: m[1], level: m[2].toLowerCase() as EffortLevel } : null;
}

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
  maxReviewRounds: z.number().int().min(1).max(3),
  fallbackProfileId: z.string().min(1).nullable(),
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
  fallbackProfileId: ProfileBaseFieldsSchema.shape.fallbackProfileId.default(null),
  configDir: ProfileBaseFieldsSchema.shape.configDir.default(null),
});
export type CreateProfileInput = z.infer<typeof CreateProfileInputSchema>;

export const UpdateProfileInputSchema = ProfileBaseFieldsSchema.partial();
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;

const RoutingRuleBaseFieldsSchema = z.object({
  role: TaskRoleSchema,
  complexity: TaskComplexitySchema.nullable(),
  profileId: z.string().min(1),
  fallbackProfileId: z.string().min(1).nullable(),
});

export const CreateRoutingRuleInputSchema = z.object({
  role: TaskRoleSchema,
  complexity: TaskComplexitySchema.nullable().default(null),
  profileId: z.string().min(1),
  fallbackProfileId: z.string().min(1).nullable().default(null),
});
export type CreateRoutingRuleInput = z.infer<typeof CreateRoutingRuleInputSchema>;

export const UpdateRoutingRuleInputSchema = RoutingRuleBaseFieldsSchema.partial();
export type UpdateRoutingRuleInput = z.infer<typeof UpdateRoutingRuleInputSchema>;

export const ReorderRoutingRulesInputSchema = z.object({
  ruleIds: z.array(z.string().min(1)).min(1),
});
export type ReorderRoutingRulesInput = z.infer<typeof ReorderRoutingRulesInputSchema>;

export const StartExecutionInputSchema = z.object({
  taskId: z.string().min(1).optional(),
  allowUnconfined: z.boolean().default(false),
  resumeSession: z.boolean().default(false),
});
export type StartExecutionInput = z.infer<typeof StartExecutionInputSchema>;

export const StopExecutionInputSchema = z.object({
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

export interface PushPrResultDTO {
  pushed: boolean;
  remote: string;
  branch: string;
  prUrl: string | null;
  message: string;
}

export const RunIntegrationInputSchema = z.object({
  command: z.string().trim().min(1).max(500).optional(),
  allowUnconfined: z.boolean().default(false),
});
export type RunIntegrationInput = z.infer<typeof RunIntegrationInputSchema>;

export const UpdateSettingsInputSchema = z.object({
  antigravityKeyringAccess: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

export interface SettingsDTO {
  /** Lets sandboxed Antigravity runs read the whole desktop keyring. Off by default. */
  antigravityKeyringAccess: boolean;
}

export interface RoutingRuleDTO {
  id: string;
  sortOrder: number;
  role: TaskRole;
  complexity: TaskComplexity | null;
  profileId: string;
  profileName: string;
  fallbackProfileId: string | null;
  fallbackProfileName: string | null;
}

export interface TaskDispatchPreviewDTO {
  taskId: string;
  externalId: string;
  title: string;
  milestone: string;
  role: PlanTaskRole;
  complexity: TaskComplexity;
  status: TaskStatus;
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
  fallbackProfileId: string | null;
  fallbackProfileName: string | null;
  selectionSource: 'override' | 'routing_rule' | 'default';
  /** Set when the routed profile cannot run as configured and another one is used instead. */
  selectionNote: string | null;
  quotaReroutedReason: string | null;
}

export interface TaskRunDTO {
  id: string;
  projectId: string;
  taskId: string;
  taskExternalId: string;
  taskTitle: string;
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
  verifyCommand: string;
  verifyExitCode: number;
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
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}

export interface TaskDiffDTO {
  taskId: string;
  externalId: string;
  branchName: string | null;
  baseCommitSha: string | null;
  headCommitSha: string | null;
  files: TaskDiffFileDTO[];
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
  canApproveMerge: boolean;
  canReject: boolean;
}

export interface GuardStateDTO {
  projectId: string;
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
