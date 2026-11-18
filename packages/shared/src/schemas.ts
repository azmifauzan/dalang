import { z } from 'zod';

export const ProviderIdSchema = z.enum(['claude-code', 'codex', 'antigravity']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const EffortLevelSchema = z.enum(['low', 'medium', 'high']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const TaskRoleSchema = z.enum(['lead', 'planner', 'engineer', 'qa', 'reviewer']);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const TaskComplexitySchema = z.enum(['low', 'medium', 'high']);
export type TaskComplexity = z.infer<typeof TaskComplexitySchema>;

export const TaskStatusSchema = z.enum(['draft', 'needs_split', 'ready', 'approved']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

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
  models: z.array(z.string()),
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

export const UpdateTaskInputSchema = CreateTaskInputSchema.partial();
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

export interface AgentProfileDTO {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  effort: EffortLevel;
  rolePrompt: string;
  permissionMode: 'workspace-write' | 'read-only' | 'accept-edits';
  timeoutMs: number;
  idleTimeoutMs: number;
  maxParallel: number;
  isDefault: boolean;
  createdAt: string;
}
