import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  mainBranch: text('main_branch').notNull().default('main'),
  leadProvider: text('lead_provider').notNull().default('claude-code'),
  leadModel: text('lead_model'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull(),
  provider: text('provider').notNull(),
  model: text('model'),
  cliSessionId: text('cli_session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  type: text('type').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

export const briefs = sqliteTable('briefs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: text('status').notNull().default('draft'),
  filePath: text('file_path').notNull(),
  createdAt: text('created_at').notNull(),
  approvedAt: text('approved_at'),
});

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  briefId: text('brief_id')
    .notNull()
    .references(() => briefs.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: text('status').notNull().default('draft'),
  filePath: text('file_path').notNull(),
  createdAt: text('created_at').notNull(),
  approvedAt: text('approved_at'),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  milestone: text('milestone').notNull(),
  role: text('role').notNull().default('engineer'),
  complexity: text('complexity').notNull().default('low'),
  status: text('status').notNull().default('ready'),
  position: integer('position').notNull().default(0),
  goal: text('goal').notNull(),
  filesAllowedJson: text('files_allowed_json').notNull().default('[]'),
  filesReferenceJson: text('files_reference_json').notNull().default('[]'),
  acceptanceCriteriaJson: text('acceptance_criteria_json').notNull().default('[]'),
  verify: text('verify').notNull(),
  needsSplit: integer('needs_split', { mode: 'boolean' }).notNull().default(false),
  splitDepth: integer('split_depth').notNull().default(0),
  parentTaskId: text('parent_task_id'),
  profileOverride: text('profile_override'),
  reviewRounds: integer('review_rounds').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnId: text('depends_on_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.dependsOnId] })],
);

export const agentProfiles = sqliteTable('agent_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  provider: text('provider').notNull(),
  model: text('model').notNull().default(''),
  effort: text('effort').notNull().default('medium'),
  rolePrompt: text('role_prompt').notNull().default(''),
  permissionMode: text('permission_mode').notNull().default('workspace-write'),
  timeoutMs: integer('timeout_ms').notNull().default(1800000),
  idleTimeoutMs: integer('idle_timeout_ms').notNull().default(180000),
  maxParallel: integer('max_parallel').notNull().default(1),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const routingRules = sqliteTable('routing_rules', {
  id: text('id').primaryKey(),
  sortOrder: integer('sort_order').notNull(),
  role: text('role').notNull(),
  complexity: text('complexity'),
  profileId: text('profile_id')
    .notNull()
    .references(() => agentProfiles.id, { onDelete: 'cascade' }),
  fallbackProfileId: text('fallback_profile_id').references(() => agentProfiles.id, {
    onDelete: 'set null',
  }),
});

export const providerEvents = sqliteTable('provider_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  profileId: text('profile_id')
    .notNull()
    .references(() => agentProfiles.id),
  provider: text('provider').notNull(),
  model: text('model'),
  status: text('status').notNull().default('running'),
  cliSessionId: text('cli_session_id'),
  attempt: integer('attempt').notNull().default(1),
  usedFallback: integer('used_fallback', { mode: 'boolean' }).notNull().default(false),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  exitCode: integer('exit_code'),
  failureReason: text('failure_reason'),
  commitBefore: text('commit_before'),
  commitAfter: text('commit_after'),
  logPath: text('log_path').notNull(),
  resultPath: text('result_path'),
  scopeWarningsJson: text('scope_warnings_json').notNull().default('[]'),
});
