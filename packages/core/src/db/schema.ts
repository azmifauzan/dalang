import { blob, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  mainBranch: text('main_branch').notNull().default('main'),
  leadProvider: text('lead_provider').notNull().default('claude-code'),
  leadModel: text('lead_model'),
  integrationCommand: text('integration_command'),
  pushAfterMerge: integer('push_after_merge', { mode: 'boolean' }).notNull().default(false),
  createPrAfterMerge: integer('create_pr_after_merge', { mode: 'boolean' }).notNull().default(false),
  gitRemote: text('git_remote'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  mode: text('mode').notNull().default('ask'),
  workState: text('work_state').notNull().default('idle'),
  phase: text('phase').notNull().default('discuss'),
  provider: text('provider').notNull(),
  model: text('model'),
  cliSessionId: text('cli_session_id'),
  archivedAt: text('archived_at'),
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

export const messageImages = sqliteTable('message_images', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  mimeType: text('mime_type').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
});

export const briefs = sqliteTable('briefs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
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
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  briefId: text('brief_id').references(() => briefs.id, { onDelete: 'cascade' }),
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
  delegatedByRunId: text('delegated_by_run_id'),
  delegationDepth: integer('delegation_depth').notNull().default(0),
  mergeTargetBranch: text('merge_target_branch'),
  profileOverride: text('profile_override'),
  reviewRounds: integer('review_rounds').notNull().default(0),
  branchName: text('branch_name'),
  mergeCommitSha: text('merge_commit_sha'),
  rejectionNote: text('rejection_note'),
  prUrl: text('pr_url'),
  pushedAt: text('pushed_at'),
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
  maxReviewRounds: integer('max_review_rounds').notNull().default(2),
  fallbackProvider: text('fallback_provider'),
  fallbackModel: text('fallback_model'),
  fallbackEffort: text('fallback_effort'),
  fallbackConfigDir: text('fallback_config_dir'),
  configDir: text('config_dir'),
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
  fallbackProvider: text('fallback_provider'),
  fallbackModel: text('fallback_model'),
  fallbackEffort: text('fallback_effort'),
  fallbackConfigDir: text('fallback_config_dir'),
});

export const providerEvents = sqliteTable('provider_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  accountKey: text('account_key'),
  type: text('type').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});

export const leadTurns = sqliteTable('lead_turns', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  phase: text('phase').notNull().default('ask'),
  provider: text('provider').notNull(),
  model: text('model'),
  status: text('status').notNull().default('completed'),
  cliSessionId: text('cli_session_id'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  failureReason: text('failure_reason'),
  logPath: text('log_path'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  estimatedCostUsd: real('estimated_cost_usd'),
  costSource: text('cost_source'),
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
  accountKey: text('account_key'),
  model: text('model'),
  kind: text('kind').notNull().default('execute'),
  branchName: text('branch_name'),
  worktreePath: text('worktree_path'),
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
  checkpointBeforeRef: text('checkpoint_before_ref'),
  checkpointAfterRef: text('checkpoint_after_ref'),
  logPath: text('log_path').notNull(),
  resultPath: text('result_path'),
  scopeWarningsJson: text('scope_warnings_json').notNull().default('[]'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  estimatedCostUsd: real('estimated_cost_usd'),
  costSource: text('cost_source'),
});

export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  round: integer('round').notNull(),
  status: text('status').notNull(),
  humanDecision: text('human_decision').notNull().default('pending'),
  humanNote: text('human_note'),
  reviewerProfileId: text('reviewer_profile_id').notNull(),
  reviewerProvider: text('reviewer_provider').notNull(),
  reviewerModel: text('reviewer_model'),
  verifyCommand: text('verify_command').notNull(),
  verifyExitCode: integer('verify_exit_code').notNull(),
  verifyOutput: text('verify_output').notNull().default(''),
  filePath: text('file_path').notNull(),
  commitSha: text('commit_sha'),
  scopeWarningsJson: text('scope_warnings_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
});

export const integrationRuns = sqliteTable('integration_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  mergeCommitSha: text('merge_commit_sha'),
  command: text('command').notNull(),
  status: text('status').notNull(),
  exitCode: integer('exit_code'),
  output: text('output').notNull().default(''),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at').notNull(),
});

export const taskRepos = sqliteTable('task_repos', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  repoPath: text('repo_path').notNull(),
  baseBranch: text('base_branch').notNull(),
  baseSha: text('base_sha').notNull(),
  branchName: text('branch_name').notNull(),
  worktreePath: text('worktree_path').notNull(),
  mergeCommitSha: text('merge_commit_sha'),
  prUrl: text('pr_url'),
  pushedAt: text('pushed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runRepoCheckpoints = sqliteTable('run_repo_checkpoints', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  repoPath: text('repo_path').notNull(),
  commitBefore: text('commit_before'),
  commitAfter: text('commit_after'),
  checkpointBeforeRef: text('checkpoint_before_ref'),
  checkpointAfterRef: text('checkpoint_after_ref'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  cronExpr: text('cron_expr'),
  webhookToken: text('webhook_token').unique(),
  webhookSecret: text('webhook_secret'),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  role: text('role').notNull().default('engineer'),
  complexity: text('complexity').notNull().default('low'),
  filesAllowedJson: text('files_allowed_json').notNull().default('[]'),
  filesReferenceJson: text('files_reference_json').notNull().default('[]'),
  acceptanceCriteriaJson: text('acceptance_criteria_json').notNull().default('[]'),
  verify: text('verify').notNull(),
  profileOverride: text('profile_override'),
  allowUnconfined: integer('allow_unconfined', { mode: 'boolean' }).notNull().default(false),
  autoMerge: integer('auto_merge', { mode: 'boolean' }).notNull().default(false),
  lastTriggeredAt: text('last_triggered_at'),
  nextRunAt: text('next_run_at'),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const automationRuns = sqliteTable('automation_runs', {
  id: text('id').primaryKey(),
  automationId: text('automation_id')
    .notNull()
    .references(() => automations.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  triggerSource: text('trigger_source').notNull(),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  status: text('status').notNull(),
  detail: text('detail'),
  payloadExcerpt: text('payload_excerpt'),
  triggeredAt: text('triggered_at').notNull(),
  finishedAt: text('finished_at'),
});

export const mcpTokens = sqliteTable('mcp_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  accessLevel: text('access_level').notNull().default('read-only'),
  tokenPrefix: text('token_prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});
