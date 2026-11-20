import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ensureDir, getDbPath } from '../paths.js';
import { ensureDalangIgnore } from '../safe-fs.js';
import type { ProviderId } from '@dalang/shared';
import { extractAgyUsage } from '../adapters/antigravity.js';
import { extractClaudeUsage } from '../adapters/claude.js';
import { accumulateCodexUsage } from '../adapters/codex.js';
import type { TurnTokenUsage } from '../adapters/types.js';
import { usageDbFields } from '../services/pricing.js';
import * as schema from './schema.js';

export type DalangDb = BetterSQLite3Database<typeof schema>;

export interface DbConnection {
  db: DalangDb;
  sqlite: Database.Database;
  dataDir: string | null;
  close: () => void;
}

const dbDataDirs = new WeakMap<object, string | null>();

export function getDbDataDir(db: DalangDb): string | null {
  return dbDataDirs.get(db) ?? null;
}

const SCHEMA_VERSION = 10;

const BOOTSTRAP_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  main_branch TEXT NOT NULL DEFAULT 'main',
  lead_provider TEXT NOT NULL DEFAULT 'claude-code',
  lead_model TEXT,
  integration_command TEXT,
  push_after_merge INTEGER NOT NULL DEFAULT 0,
  create_pr_after_merge INTEGER NOT NULL DEFAULT 0,
  git_remote TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'ask',
  work_state TEXT NOT NULL DEFAULT 'idle',
  phase TEXT NOT NULL DEFAULT 'discuss',
  provider TEXT NOT NULL,
  model TEXT,
  cli_session_id TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  brief_id TEXT REFERENCES briefs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  milestone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'engineer',
  complexity TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'ready',
  position INTEGER NOT NULL DEFAULT 0,
  goal TEXT NOT NULL,
  files_allowed_json TEXT NOT NULL DEFAULT '[]',
  files_reference_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  verify TEXT NOT NULL,
  needs_split INTEGER NOT NULL DEFAULT 0,
  split_depth INTEGER NOT NULL DEFAULT 0,
  parent_task_id TEXT,
  profile_override TEXT,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  branch_name TEXT,
  merge_commit_sha TEXT,
  rejection_note TEXT,
  pr_url TEXT,
  pushed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT 'medium',
  role_prompt TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'workspace-write',
  timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  idle_timeout_ms INTEGER NOT NULL DEFAULT 180000,
  max_parallel INTEGER NOT NULL DEFAULT 1,
  max_review_rounds INTEGER NOT NULL DEFAULT 2,
  fallback_profile_id TEXT,
  fallback_provider TEXT,
  fallback_model TEXT,
  fallback_effort TEXT,
  fallback_config_dir TEXT,
  config_dir TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  role TEXT NOT NULL,
  complexity TEXT,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  fallback_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  fallback_provider TEXT,
  fallback_model TEXT,
  fallback_effort TEXT,
  fallback_config_dir TEXT
);

CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_key TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_turns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  phase TEXT NOT NULL DEFAULT 'ask',
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  cli_session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  failure_reason TEXT,
  log_path TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  estimated_cost_usd REAL,
  cost_source TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  provider TEXT NOT NULL,
  account_key TEXT,
  model TEXT,
  kind TEXT NOT NULL DEFAULT 'execute',
  branch_name TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  cli_session_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  used_fallback INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  failure_reason TEXT,
  commit_before TEXT,
  commit_after TEXT,
  checkpoint_before_ref TEXT,
  checkpoint_after_ref TEXT,
  log_path TEXT NOT NULL,
  result_path TEXT,
  scope_warnings_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  estimated_cost_usd REAL,
  cost_source TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  status TEXT NOT NULL,
  human_decision TEXT NOT NULL DEFAULT 'pending',
  human_note TEXT,
  reviewer_profile_id TEXT NOT NULL,
  reviewer_provider TEXT NOT NULL,
  reviewer_model TEXT,
  verify_command TEXT NOT NULL,
  verify_exit_code INTEGER NOT NULL,
  verify_output TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  commit_sha TEXT,
  scope_warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS integration_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  merge_commit_sha TEXT,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  output TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
`;

/** Role instructions of the seeded profiles. Earlier releases seeded shorter text; see refreshDefaultRolePrompts. */
const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  'profile-lead': "You are the Lead: the architect and planner of this project, not its coder.\n- Clarify before you plan. Ask only questions whose answers change what gets built, one decision per question, and offer concrete options with the trade-off of each.\n- Write briefs a stranger could build from: goal, scope, non-goals, constraints, and measurable done-criteria. Never invent requirements the user did not state; mark your own assumptions as assumptions.\n- Split work into small tasks that one agent can finish and verify on its own. Give every task a precise goal, acceptance criteria that can be checked, the narrowest files_allowed that still works, dependencies only when one task truly needs another's output, and a verify command that fails when the work is wrong.\n- Keep tasks that touch the same files apart in time, not in parallel. Mark a task needs_split instead of handing a vague or oversized one to a coder.\n- Read PROJECT.md and the existing code before deciding on structure. Follow the project's conventions and reuse what exists before proposing something new.",
  'profile-coder-small': "You are a focused engineer working a small, well-scoped task.\n- Do exactly what the goal and acceptance criteria ask, with the smallest change that satisfies them. No refactors, renames, or cleanups outside the task, and no new dependencies.\n- Read PROJECT.md and the code around your change first. Match the existing style, naming, and patterns, and reuse existing helpers.\n- Stay inside files_allowed. If the task needs a file outside it, stop and report it as blocked instead of editing it.\n- Cover the new or changed behaviour with a test when the project has tests, then run the verify command and fix what it reports. Never weaken or delete a test to make it pass.\n- Report honestly: what you changed, which commands you ran and their results, and anything left undone. If the goal is ambiguous, contradictory, or larger than described, stop and report blocked with the reason rather than guessing.",
  'profile-coder-heavy': "You are a senior engineer taking on multi-file or high-complexity work.\n- Understand before you edit: read the relevant modules, trace the data flow and the callers of anything you change, and form a short plan first. Prefer the root cause over a patch on the symptom.\n- Keep the change cohesive. Put logic where it belongs, preserve public interfaces and existing behaviour that the task does not mention, and reuse existing abstractions before adding new ones. Add a dependency only when it clearly lowers total complexity.\n- Handle the edge cases: empty and invalid input, error paths, concurrency, partial failure, and data loss. Validate at trust boundaries and never log or commit secrets.\n- Write tests for the behaviour you add or change, including the failure cases, and update docs or types the change touches. Run the verify command and fix real causes; never weaken or delete a test to get green.\n- Stay inside files_allowed. If correctness needs a change beyond it, stop and report blocked with the exact file and reason. Finish by summarising what changed, how you verified it, and the risks or follow-ups that remain.",
  'profile-reviewer': "You are an independent reviewer. You did not write this code and you do not fix it; you judge it.\n- Start from the acceptance criteria. Check each one against the actual diff and, where possible, against real behaviour. Run the verify command yourself and report its real output; do not trust the coder's summary.\n- Check that every changed file is inside files_allowed and that nothing unrelated slipped in.\n- Hunt for real defects: logic errors, unhandled edge cases and error paths, race conditions, resource leaks, broken or missing tests, regressions in untouched callers, and security problems such as injection, path traversal, unsafe deserialisation, and leaked secrets.\n- Rate each finding honestly: critical (breaks correctness or security), major (a likely bug or a missed criterion), minor (small and safe to defer), info (an observation). Fail the review only for unmet acceptance criteria or critical and major defects. Do not fail on style or personal preference.\n- Every finding names the file and line, says what goes wrong and when, and suggests a concrete fix. No speculation and no vague advice. Never modify files.",
};

/** Prompts written by earlier releases. A profile still holding one of these was never customised. */
const PREVIOUS_ROLE_PROMPTS: Record<string, string> = {
  'profile-lead': "Lead architect: clarify goals, author concise briefs, and decompose tasks with clear verify commands.",
  'profile-coder-small': "Focused engineer for well-scoped, low-complexity tasks.",
  'profile-coder-heavy': "Senior engineer for multi-file or high-complexity tasks.",
  'profile-reviewer': "Independent reviewer verifying acceptance criteria and running test commands.",
};

/** Upgrades untouched seeded profiles to the current role instructions; edited ones are left alone. */
function refreshDefaultRolePrompts(db: DalangDb): void {
  for (const [id, previous] of Object.entries(PREVIOUS_ROLE_PROMPTS)) {
    db.update(schema.agentProfiles)
      .set({ rolePrompt: DEFAULT_ROLE_PROMPTS[id] })
      .where(and(eq(schema.agentProfiles.id, id), eq(schema.agentProfiles.rolePrompt, previous)))
      .run();
  }
}

function seedDefaults(db: DalangDb): void {
  const existing = db.select().from(schema.agentProfiles).all();
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  const defaultProfiles = [
    {
      id: 'profile-lead',
      name: 'lead',
      provider: 'claude-code',
      model: '',
      effort: 'high',
      rolePrompt: DEFAULT_ROLE_PROMPTS['profile-lead'],
      permissionMode: 'workspace-write',
      timeoutMs: 1800000,
      idleTimeoutMs: 180000,
      maxParallel: 1,
      maxReviewRounds: 2,
      isDefault: true,
      createdAt: now,
    },
    {
      id: 'profile-coder-small',
      name: 'coder-small',
      provider: 'codex',
      model: '',
      effort: 'low',
      rolePrompt: DEFAULT_ROLE_PROMPTS['profile-coder-small'],
      permissionMode: 'workspace-write',
      timeoutMs: 1800000,
      idleTimeoutMs: 180000,
      maxParallel: 2,
      maxReviewRounds: 2,
      isDefault: true,
      createdAt: now,
    },
    {
      id: 'profile-coder-heavy',
      name: 'coder-heavy',
      provider: 'claude-code',
      model: '',
      effort: 'high',
      rolePrompt: DEFAULT_ROLE_PROMPTS['profile-coder-heavy'],
      permissionMode: 'workspace-write',
      timeoutMs: 1800000,
      idleTimeoutMs: 180000,
      maxParallel: 1,
      maxReviewRounds: 2,
      isDefault: true,
      createdAt: now,
    },
    {
      id: 'profile-reviewer',
      name: 'reviewer',
      provider: 'antigravity',
      model: 'gemini-4-hydrogen-high',
      effort: 'high',
      rolePrompt: DEFAULT_ROLE_PROMPTS['profile-reviewer'],
      permissionMode: 'read-only',
      timeoutMs: 1200000,
      idleTimeoutMs: 180000,
      maxParallel: 1,
      maxReviewRounds: 2,
      isDefault: true,
      createdAt: now,
    },
  ];

  db.insert(schema.agentProfiles).values(defaultProfiles).run();

  db.insert(schema.routingRules)
    .values([
      {
        id: crypto.randomUUID(),
        sortOrder: 1,
        role: 'lead',
        complexity: null,
        profileId: 'profile-lead',
        fallbackProvider: null,
        fallbackModel: null,
        fallbackEffort: null,
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 2,
        role: 'engineer',
        complexity: 'low',
        profileId: 'profile-coder-small',
        fallbackProvider: 'claude-code',
        fallbackModel: '',
        fallbackEffort: 'high',
        fallbackConfigDir: null,
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 3,
        role: 'engineer',
        complexity: 'medium',
        profileId: 'profile-coder-heavy',
        fallbackProvider: 'codex',
        fallbackModel: '',
        fallbackEffort: 'high',
        fallbackConfigDir: null,
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 4,
        role: 'engineer',
        complexity: 'high',
        profileId: 'profile-coder-heavy',
        fallbackProvider: 'codex',
        fallbackModel: '',
        fallbackEffort: 'high',
        fallbackConfigDir: null,
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 5,
        role: 'qa',
        complexity: null,
        profileId: 'profile-reviewer',
        fallbackProvider: 'claude-code',
        fallbackModel: '',
        fallbackEffort: 'high',
        fallbackConfigDir: null,
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 6,
        role: 'reviewer',
        complexity: null,
        profileId: 'profile-reviewer',
        fallbackProvider: 'claude-code',
        fallbackModel: '',
        fallbackEffort: 'high',
        fallbackConfigDir: null,
      },
    ])
    .run();
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function addColumnsV4(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, 'projects', 'integration_command', 'TEXT');
  addColumnIfMissing(sqlite, 'tasks', 'branch_name', 'TEXT');
  addColumnIfMissing(sqlite, 'tasks', 'merge_commit_sha', 'TEXT');
  addColumnIfMissing(sqlite, 'tasks', 'rejection_note', 'TEXT');
  addColumnIfMissing(sqlite, 'agent_profiles', 'max_review_rounds', 'INTEGER NOT NULL DEFAULT 2');
  addColumnIfMissing(sqlite, 'runs', 'kind', "TEXT NOT NULL DEFAULT 'execute'");
  addColumnIfMissing(sqlite, 'runs', 'branch_name', 'TEXT');
}

function seedReviewerRule(db: DalangDb): void {
  const existingRules = db.select().from(schema.routingRules).all();
  if (!existingRules.some((r) => r.role === 'reviewer')) {
    const profiles = db.select().from(schema.agentProfiles).all();
    const reviewer = profiles.find((p) => p.id === 'profile-reviewer') ?? profiles[0];
    const lead = profiles.find((p) => p.id === 'profile-lead');
    if (reviewer) {
      const nextOrder = existingRules.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 1;
      db.insert(schema.routingRules)
        .values({
          id: crypto.randomUUID(),
          sortOrder: nextOrder,
          role: 'reviewer',
          complexity: null,
          profileId: reviewer.id,
          ...(lead && lead.id !== reviewer.id
            ? { fallbackProvider: lead.provider, fallbackModel: lead.model, fallbackEffort: lead.effort, fallbackConfigDir: lead.configDir }
            : {}),
        })
        .run();
    }
  }
}

function migrateV1ToV2(db: DalangDb): void {
  const existingRules = db.select().from(schema.routingRules).all();
  const hasMediumEngineer = existingRules.some(
    (r) => r.role === 'engineer' && r.complexity === 'medium',
  );
  if (hasMediumEngineer) return;

  const profiles = db.select().from(schema.agentProfiles).all();
  const heavy = profiles.find((p) => p.id === 'profile-coder-heavy');
  const lead = profiles.find((p) => p.id === 'profile-lead');
  if (heavy) {
    db.insert(schema.routingRules)
      .values({
        id: crypto.randomUUID(),
        sortOrder: 3,
        role: 'engineer',
        complexity: 'medium',
        profileId: heavy.id,
        ...(lead
          ? { fallbackProvider: lead.provider, fallbackModel: lead.model, fallbackEffort: lead.effort, fallbackConfigDir: lead.configDir }
          : {}),
      })
      .run();
  }
}

function migrateToV5(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, 'runs', 'worktree_path', 'TEXT');
}

function migrateToV6(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, 'agent_profiles', 'fallback_profile_id', 'TEXT');
}

function migrateToV7(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, 'projects', 'push_after_merge', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'create_pr_after_merge', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'git_remote', 'TEXT');
  addColumnIfMissing(sqlite, 'tasks', 'pr_url', 'TEXT');
  addColumnIfMissing(sqlite, 'tasks', 'pushed_at', 'TEXT');
  addColumnIfMissing(sqlite, 'agent_profiles', 'config_dir', 'TEXT');
  addColumnIfMissing(sqlite, 'provider_events', 'account_key', 'TEXT');
  addColumnIfMissing(sqlite, 'runs', 'account_key', 'TEXT');
  addColumnIfMissing(sqlite, 'runs', 'checkpoint_before_ref', 'TEXT');
  addColumnIfMissing(sqlite, 'runs', 'checkpoint_after_ref', 'TEXT');
  addColumnIfMissing(sqlite, 'runs', 'input_tokens', 'INTEGER');
  addColumnIfMissing(sqlite, 'runs', 'output_tokens', 'INTEGER');
  addColumnIfMissing(sqlite, 'runs', 'cache_read_tokens', 'INTEGER');
  addColumnIfMissing(sqlite, 'runs', 'cache_write_tokens', 'INTEGER');
  addColumnIfMissing(sqlite, 'runs', 'estimated_cost_usd', 'REAL');
  addColumnIfMissing(sqlite, 'runs', 'cost_source', 'TEXT');
}

/**
 * v8: a fallback is a CLI, model, and effort instead of a profile, and the seeded engineer rules
 * run low, medium, high (an older upgrade left medium after high).
 */
function migrateToV8(sqlite: Database.Database): void {
  for (const table of ['agent_profiles', 'routing_rules']) {
    addColumnIfMissing(sqlite, table, 'fallback_provider', 'TEXT');
    addColumnIfMissing(sqlite, table, 'fallback_model', 'TEXT');
    addColumnIfMissing(sqlite, table, 'fallback_effort', 'TEXT');
    addColumnIfMissing(sqlite, table, 'fallback_config_dir', 'TEXT');
    sqlite.exec(`
      UPDATE ${table} SET
        fallback_provider = (SELECT f.provider FROM agent_profiles f WHERE f.id = ${table}.fallback_profile_id),
        fallback_model = (SELECT f.model FROM agent_profiles f WHERE f.id = ${table}.fallback_profile_id),
        fallback_effort = (SELECT f.effort FROM agent_profiles f WHERE f.id = ${table}.fallback_profile_id),
        fallback_config_dir = (SELECT f.config_dir FROM agent_profiles f WHERE f.id = ${table}.fallback_profile_id)
      WHERE fallback_profile_id IS NOT NULL AND fallback_provider IS NULL
        AND EXISTS (SELECT 1 FROM agent_profiles f WHERE f.id = ${table}.fallback_profile_id);
    `);
  }
  // Hand the sort slots the three engineer tiers already occupy back out in low, medium, high order.
  const tiers = sqlite
    .prepare(
      `SELECT id, complexity, sort_order FROM routing_rules WHERE role = 'engineer' AND complexity IN ('low', 'medium', 'high')`,
    )
    .all() as Array<{ id: string; complexity: string; sort_order: number }>;
  const rank = { low: 0, medium: 1, high: 2 } as Record<string, number>;
  const slots = tiers.map((r) => r.sort_order).sort((a, b) => a - b);
  const ordered = [...tiers].sort((a, b) => rank[a.complexity] - rank[b.complexity]);
  const update = sqlite.prepare('UPDATE routing_rules SET sort_order = ? WHERE id = ?');
  ordered.forEach((r, i) => update.run(slots[i], r.id));
  // Close any gaps or duplicate slots so every rule has its own position.
  const all = sqlite
    .prepare(
      `SELECT id FROM routing_rules ORDER BY sort_order,
         CASE complexity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, rowid`,
    )
    .all() as Array<{ id: string }>;
  all.forEach((r, i) => update.run(i + 1, r.id));
}

function moveFileSafe(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  try {
    if (fs.lstatSync(src).isSymbolicLink()) return;
  } catch {
    return;
  }
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {
      // keep copy if unlink fails
    }
  }
}

function moveDirFilesRecursive(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  try {
    if (fs.lstatSync(srcDir).isSymbolicLink()) return;
  } catch {
    return;
  }
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      moveDirFilesRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      moveFileSafe(srcPath, destPath);
    }
  }
}

function rewriteLegacyDalangPath(relPath: string, sessionId: string): string {
  const norm = relPath.replace(/\\/g, '/');
  if (norm.startsWith('.dalang/sessions/')) return norm;
  if (norm.startsWith('.dalang/')) {
    return `.dalang/sessions/${sessionId}/${norm.slice('.dalang/'.length)}`;
  }
  return norm;
}

function deriveTitleFromText(raw: string, fallback: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

/**
 * v9: session modes (ask / quick / full), per-session briefs/plans/artifacts under
 * `.dalang/sessions/<sessionId>/`, nullable `plans.brief_id` for Quick mode, and a partial unique
 * index allowing at most one `working` session per project.
 */
function migrateToV9(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, 'sessions', 'title', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(sqlite, 'sessions', 'mode', "TEXT NOT NULL DEFAULT 'ask'");
  addColumnIfMissing(sqlite, 'sessions', 'work_state', "TEXT NOT NULL DEFAULT 'idle'");
  addColumnIfMissing(sqlite, 'sessions', 'archived_at', 'TEXT');
  addColumnIfMissing(sqlite, 'briefs', 'session_id', 'TEXT REFERENCES sessions(id) ON DELETE CASCADE');

  const planCols = sqlite.pragma('table_info(plans)') as Array<{ name: string; notnull: number }>;
  const hasSessionId = planCols.some((c) => c.name === 'session_id');
  const briefNotNull = planCols.some((c) => c.name === 'brief_id' && c.notnull === 1);
  if (!hasSessionId || briefNotNull) {
    sqlite.pragma('foreign_keys = OFF');
    try {
      sqlite.exec(`
        BEGIN;
        CREATE TABLE plans_v9 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
          brief_id TEXT REFERENCES briefs(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          file_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          approved_at TEXT
        );
        INSERT INTO plans_v9 (id, project_id, session_id, brief_id, version, status, file_path, created_at, approved_at)
        SELECT id, project_id, ${hasSessionId ? 'session_id' : 'NULL'}, brief_id, version, status, file_path, created_at, approved_at
        FROM plans;
        DROP TABLE plans;
        ALTER TABLE plans_v9 RENAME TO plans;
        COMMIT;
      `);
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      sqlite.pragma('foreign_keys = ON');
    }
  }

  // Migrate every project's existing stage, messages, briefs, plans, and `.dalang/` artifacts into
  // one Full session; empty projects start with no sessions so their chat opens empty.
  const projectRows = sqlite
    .prepare('SELECT id, name, path, lead_provider, lead_model, created_at, updated_at FROM projects')
    .all() as Array<{
    id: string;
    name: string;
    path: string;
    lead_provider: string;
    lead_model: string | null;
    created_at: string;
    updated_at: string;
  }>;

  for (const proj of projectRows) {
    // v0.6 and earlier wrote `.dalang/.gitignore` with only `tmp/`; session logs would show up as untracked.
    // Best effort: a missing project folder or a refused symlink must not block the upgrade.
    if (fs.existsSync(path.join(proj.path, '.dalang'))) {
      try {
        ensureDalangIgnore(proj.path);
      } catch {
        // leave the file as it is
      }
    }

    const sessRows = sqlite
      .prepare('SELECT id, phase, provider, model, cli_session_id, created_at, updated_at FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(proj.id) as Array<{
      id: string;
      phase: string;
      provider: string;
      model: string | null;
      cli_session_id: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const briefRows = sqlite
      .prepare('SELECT id, version, status, file_path, created_at FROM briefs WHERE project_id = ? ORDER BY version DESC')
      .all(proj.id) as Array<{
      id: string;
      version: number;
      status: string;
      file_path: string;
      created_at: string;
    }>;

    const planRows = sqlite
      .prepare('SELECT id, version, status, file_path, created_at FROM plans WHERE project_id = ? ORDER BY version DESC')
      .all(proj.id) as Array<{
      id: string;
      version: number;
      status: string;
      file_path: string;
      created_at: string;
    }>;

    const msgCountRow = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m INNER JOIN sessions s ON s.id = m.session_id WHERE s.project_id = ?`,
      )
      .get(proj.id) as { n: number };
    const hasActivity = briefRows.length > 0 || planRows.length > 0 || msgCountRow.n > 0;

    if (!hasActivity) {
      // Remove empty legacy sessions so the project starts with no session and opens an empty chat.
      sqlite.prepare('DELETE FROM sessions WHERE project_id = ?').run(proj.id);
      continue;
    }

    let primarySessionId: string;
    if (sessRows.length > 0) {
      primarySessionId = sessRows[0].id;
      if (sessRows.length > 1) {
        const extraIds = sessRows.slice(1).map((s) => s.id);
        for (const extraId of extraIds) {
          sqlite.prepare('UPDATE messages SET session_id = ? WHERE session_id = ?').run(primarySessionId, extraId);
          sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(extraId);
        }
      }
    } else {
      primarySessionId = crypto.randomUUID();
      sqlite
        .prepare(
          `INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, model, cli_session_id, archived_at, created_at, updated_at)
           VALUES (?, ?, '', 'full', 'idle', 'discuss', ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          primarySessionId,
          proj.id,
          proj.lead_provider,
          proj.lead_model,
          proj.created_at,
          proj.updated_at,
        );
    }

    // Derive title from latest brief JSON, else first user message, else project name.
    let title = '';
    if (briefRows.length > 0 && fs.existsSync(proj.path)) {
      const briefAbs = path.join(proj.path, briefRows[0].file_path);
      if (fs.existsSync(briefAbs)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(briefAbs, 'utf8')) as { title?: string };
          if (parsed.title?.trim()) {
            title = deriveTitleFromText(parsed.title, proj.name);
          }
        } catch {
          // ignore unreadable brief file
        }
      }
    }
    if (!title) {
      const firstUserMsg = sqlite
        .prepare(
          `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`,
        )
        .get(primarySessionId) as { content: string } | undefined;
      if (firstUserMsg?.content) {
        title = deriveTitleFromText(firstUserMsg.content, proj.name);
      }
    }
    if (!title) {
      title = proj.name;
    }

    // Derive phase and work_state.
    let phase = 'discuss';
    if (planRows.some((p) => p.status === 'approved')) phase = 'run';
    else if (planRows.length > 0) phase = 'list';
    else if (briefRows.length > 0) phase = 'agree';

    const unfinishedRow = sqlite
      .prepare(
        `SELECT COUNT(*) AS n
         FROM tasks t
         INNER JOIN plans p ON p.id = t.plan_id
         WHERE p.project_id = ?
           AND (
             t.status IN ('running', 'reviewing', 'awaiting_merge', 'review_failed')
             OR (t.branch_name IS NOT NULL AND t.branch_name != '' AND t.status != 'done')
           )`,
      )
      .get(proj.id) as { n: number };
    const workState = unfinishedRow.n > 0 ? 'working' : 'idle';

    sqlite
      .prepare(`UPDATE sessions SET title = ?, mode = 'full', work_state = ?, phase = ? WHERE id = ?`)
      .run(title, workState, phase, primarySessionId);

    sqlite.prepare('UPDATE briefs SET session_id = ? WHERE project_id = ?').run(primarySessionId, proj.id);
    sqlite.prepare('UPDATE plans SET session_id = ? WHERE project_id = ?').run(primarySessionId, proj.id);

    // Move legacy `.dalang/` artifacts into `.dalang/sessions/<sessionId>/` and rewrite DB paths.
    const projectExists = fs.existsSync(proj.path);
    const sessionDirAbs = path.join(proj.path, '.dalang', 'sessions', primarySessionId);

    for (const b of briefRows) {
      const nextPath = rewriteLegacyDalangPath(b.file_path, primarySessionId);
      if (nextPath !== b.file_path) {
        if (projectExists) {
          moveFileSafe(path.join(proj.path, b.file_path), path.join(proj.path, nextPath));
        }
        sqlite.prepare('UPDATE briefs SET file_path = ? WHERE id = ?').run(nextPath, b.id);
      }
    }

    for (const p of planRows) {
      const nextPath = rewriteLegacyDalangPath(p.file_path, primarySessionId);
      if (nextPath !== p.file_path) {
        if (projectExists) {
          moveFileSafe(path.join(proj.path, p.file_path), path.join(proj.path, nextPath));
        }
        sqlite.prepare('UPDATE plans SET file_path = ? WHERE id = ?').run(nextPath, p.id);
      }
    }

    const runRows = sqlite
      .prepare('SELECT id, log_path, result_path FROM runs WHERE project_id = ?')
      .all(proj.id) as Array<{ id: string; log_path: string; result_path: string | null }>;
    for (const r of runRows) {
      const nextLog = rewriteLegacyDalangPath(r.log_path, primarySessionId);
      const nextResult = r.result_path ? rewriteLegacyDalangPath(r.result_path, primarySessionId) : null;
      if (projectExists) {
        if (nextLog !== r.log_path) {
          moveFileSafe(path.join(proj.path, r.log_path), path.join(proj.path, nextLog));
        }
        if (r.result_path && nextResult && nextResult !== r.result_path) {
          moveFileSafe(path.join(proj.path, r.result_path), path.join(proj.path, nextResult));
        }
      }
      if (nextLog !== r.log_path || nextResult !== r.result_path) {
        sqlite
          .prepare('UPDATE runs SET log_path = ?, result_path = ? WHERE id = ?')
          .run(nextLog, nextResult, r.id);
      }
    }

    const reviewRows = sqlite
      .prepare('SELECT id, file_path FROM reviews WHERE project_id = ?')
      .all(proj.id) as Array<{ id: string; file_path: string }>;
    for (const rev of reviewRows) {
      const nextPath = rewriteLegacyDalangPath(rev.file_path, primarySessionId);
      if (nextPath !== rev.file_path) {
        if (projectExists) {
          moveFileSafe(path.join(proj.path, rev.file_path), path.join(proj.path, nextPath));
        }
        sqlite.prepare('UPDATE reviews SET file_path = ? WHERE id = ?').run(nextPath, rev.id);
      }
    }

    // Move remaining legacy discuss/tasks/logs files under `.dalang/sessions/<sessionId>/`.
    if (projectExists) {
      for (const sub of ['discuss', 'tasks', 'logs']) {
        moveDirFilesRecursive(path.join(proj.path, '.dalang', sub), path.join(sessionDirAbs, sub));
      }
    }
  }
}

const LEAD_LOG_FILE_RE = /^(ask-|quick-plan-|discuss-round-|brief-|plan-|split-).*\.log$/;

function inferLeadPhaseFromLogName(fileName: string): string {
  if (fileName.startsWith('ask-')) return 'ask';
  if (fileName.startsWith('quick-plan-')) return 'quick';
  if (fileName.startsWith('discuss-round-')) return 'discuss';
  if (fileName.startsWith('brief-')) return 'agree';
  return 'list';
}

function parseLeadLogFile(
  absPath: string,
  fallbackProvider: ProviderId,
  fallbackModel: string | null,
): {
  provider: ProviderId;
  model: string | null;
  cliSessionId: string | null;
  status: 'completed' | 'failed';
  durationMs: number | null;
  usage?: TurnTokenUsage;
} | null {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  let provider: ProviderId | null = null;
  let model: string | null = fallbackModel;
  let cliSessionId: string | null = null;
  let status: 'completed' | 'failed' = 'completed';
  let durationMs: number | null = null;
  let usage: TurnTokenUsage | undefined;
  let codexAcc: TurnTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    model: fallbackModel,
  };
  let sawCodexUsage = false;
  let sawJsonEvent = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      sawJsonEvent = true;

      if (ev.event === 'init' || ev.event === 'step_update' || ev.event === 'result') {
        provider = 'antigravity';
        if (typeof ev.conversation_id === 'string' && ev.conversation_id) {
          cliSessionId = ev.conversation_id;
        }
        if (ev.init && typeof ev.init === 'object') {
          const initObj = ev.init as Record<string, unknown>;
          if (typeof initObj.model === 'string' && initObj.model.trim()) {
            model = initObj.model.trim();
          }
        }
        if (ev.result && typeof ev.result === 'object') {
          const inner = ev.result as Record<string, unknown>;
          if (typeof inner.conversation_id === 'string' && inner.conversation_id) {
            cliSessionId = inner.conversation_id;
          }
          if (typeof inner.duration_seconds === 'number' && Number.isFinite(inner.duration_seconds)) {
            durationMs = Math.max(0, Math.round(inner.duration_seconds * 1000));
          }
          if (typeof inner.status === 'string' && inner.status !== 'SUCCESS') {
            status = 'failed';
          }
        }
        const parsedAgy = extractAgyUsage(ev, model);
        if (parsedAgy) usage = parsedAgy;
        continue;
      }

      if (
        typeof ev.claude_code_version === 'string' ||
        ev.modelUsage !== undefined ||
        (ev.type === 'system' && ev.subtype === 'init')
      ) {
        provider = 'claude-code';
      }
      if (typeof ev.session_id === 'string' && ev.session_id) {
        cliSessionId = ev.session_id;
      }
      if (ev.type === 'system' && typeof ev.model === 'string' && ev.model.trim()) {
        model = ev.model.trim();
      }
      if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
        const msg = ev.message as { model?: string };
        if (typeof msg.model === 'string' && msg.model.trim()) {
          model = msg.model.trim();
        }
      }
      if (ev.type === 'result') {
        provider = provider ?? 'claude-code';
        if (typeof ev.duration_ms === 'number' && Number.isFinite(ev.duration_ms)) {
          durationMs = Math.max(0, Math.round(ev.duration_ms));
        }
        if (ev.is_error === true) {
          status = 'failed';
        }
        const parsedClaude = extractClaudeUsage(ev, model);
        if (parsedClaude) {
          usage = parsedClaude;
          if (parsedClaude.model) model = parsedClaude.model;
        }
        continue;
      }

      if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
        provider = 'codex';
        cliSessionId = ev.thread_id;
      }
      if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
        provider = 'codex';
        codexAcc = accumulateCodexUsage(codexAcc, ev.usage as Record<string, unknown>, model);
        sawCodexUsage = true;
      }
      if (ev.type === 'token_usage_record' && ev.payload && typeof ev.payload === 'object') {
        const payload = ev.payload as { usage?: Record<string, unknown> };
        if (payload.usage && typeof payload.usage === 'object') {
          provider = 'codex';
          codexAcc = accumulateCodexUsage(codexAcc, payload.usage, model);
          sawCodexUsage = true;
        }
      }
    } catch {
      // ignore non-JSON line
    }
  }

  if (!sawJsonEvent) return null;
  if (sawCodexUsage && !usage) {
    usage = codexAcc;
  }
  const resolvedProvider = provider ?? fallbackProvider;
  const resolvedModel = usage?.model?.trim() || model?.trim() || null;
  return {
    provider: resolvedProvider,
    model: resolvedModel,
    cliSessionId,
    status,
    durationMs,
    ...(usage ? { usage: { ...usage, model: resolvedModel } } : {}),
  };
}

/**
 * Backfills `lead_turns` from existing `.dalang/` Lead log files on disk when upgrading a project
 * that already ran Lead sessions before Lead-turn telemetry was stored in SQLite.
 */
function backfillLeadTurnsFromDisk(sqlite: Database.Database): void {
  const countRow = sqlite.prepare('SELECT COUNT(*) AS n FROM lead_turns').get() as { n: number };
  if (countRow.n > 0) return;

  const projectRows = sqlite
    .prepare('SELECT id, path, lead_provider, lead_model FROM projects')
    .all() as Array<{
    id: string;
    path: string;
    lead_provider: string;
    lead_model: string | null;
  }>;
  if (projectRows.length === 0) return;

  const insertTurn = sqlite.prepare(`
    INSERT INTO lead_turns (
      id, project_id, session_id, phase, provider, model, status, cli_session_id,
      started_at, finished_at, failure_reason, log_path,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      estimated_cost_usd, cost_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const proj of projectRows) {
    const dalangDir = path.join(proj.path, '.dalang');
    if (!fs.existsSync(dalangDir)) continue;
    try {
      if (fs.lstatSync(dalangDir).isSymbolicLink()) continue;
    } catch {
      continue;
    }

    const sessionRows = sqlite
      .prepare('SELECT id, provider, model FROM sessions WHERE project_id = ?')
      .all(proj.id) as Array<{ id: string; provider: string; model: string | null }>;
    const sessionById = new Map(sessionRows.map((s) => [s.id, s]));

    const candidateFiles: Array<{ absPath: string; relPath: string; hintSessionId: string | null }> = [];
    const collectDir = (dirAbs: string, hintSessionId: string | null) => {
      if (!fs.existsSync(dirAbs)) return;
      try {
        if (fs.lstatSync(dirAbs).isSymbolicLink()) return;
        for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          if (!LEAD_LOG_FILE_RE.test(entry.name)) continue;
          const absPath = path.join(dirAbs, entry.name);
          const relPath = path.relative(proj.path, absPath).replace(/\\/g, '/');
          const askMatch = entry.name.match(/^ask-([0-9a-fA-F-]{36})-\d+\.log$/);
          candidateFiles.push({
            absPath,
            relPath,
            hintSessionId: hintSessionId ?? (askMatch ? askMatch[1] : null),
          });
        }
      } catch {
        // ignore unreadable directories
      }
    };

    collectDir(path.join(dalangDir, 'tmp'), null);
    collectDir(path.join(dalangDir, 'logs'), null);
    const sessionsRoot = path.join(dalangDir, 'sessions');
    if (fs.existsSync(sessionsRoot)) {
      try {
        if (!fs.lstatSync(sessionsRoot).isSymbolicLink()) {
          for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            collectDir(path.join(sessionsRoot, entry.name, 'logs'), entry.name);
            collectDir(path.join(sessionsRoot, entry.name, 'tmp'), entry.name);
          }
        }
      } catch {
        // ignore unreadable sessions dir
      }
    }

    for (const item of candidateFiles) {
      const matchedSession = item.hintSessionId ? sessionById.get(item.hintSessionId) : undefined;
      const fallbackProvider = (matchedSession?.provider ?? proj.lead_provider ?? 'claude-code') as ProviderId;
      const fallbackModel = matchedSession?.model ?? proj.lead_model ?? null;
      const parsed = parseLeadLogFile(item.absPath, fallbackProvider, fallbackModel);
      if (!parsed) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(item.absPath);
      } catch {
        continue;
      }

      const fileName = path.basename(item.absPath);
      const tsMatch = fileName.match(/-(\d{12,14})\.log$/);
      const fileStartMs = tsMatch ? Number(tsMatch[1]) : null;
      const mtimeMs = Math.round(stat.mtimeMs);
      const startMs =
        fileStartMs !== null && Number.isFinite(fileStartMs)
          ? fileStartMs
          : parsed.durationMs !== null
            ? Math.max(0, mtimeMs - parsed.durationMs)
            : mtimeMs;
      const endMs =
        parsed.durationMs !== null
          ? startMs + parsed.durationMs
          : Math.max(startMs, mtimeMs);

      const usageFields = usageDbFields(parsed.provider, parsed.model, parsed.usage);
      insertTurn.run(
        crypto.randomUUID(),
        proj.id,
        matchedSession ? matchedSession.id : null,
        inferLeadPhaseFromLogName(fileName),
        parsed.provider,
        parsed.model,
        parsed.status,
        parsed.cliSessionId,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
        item.relPath,
        usageFields.inputTokens ?? null,
        usageFields.outputTokens ?? null,
        usageFields.cacheReadTokens ?? null,
        usageFields.cacheWriteTokens ?? null,
        usageFields.estimatedCostUsd ?? null,
        usageFields.costSource ?? null,
      );
    }
  }
}

export function openDatabase(dbFilePath: string = getDbPath()): DbConnection {
  const dataDir = dbFilePath !== ':memory:' ? path.dirname(dbFilePath) : null;
  if (dataDir) {
    ensureDir(dataDir);
  }
  const sqlite = new Database(dbFilePath);
  const storedVersion = Number(sqlite.pragma('user_version', { simple: true }));
  if (storedVersion > SCHEMA_VERSION) {
    sqlite.close();
    throw new Error(
      `Database schema v${storedVersion} is newer than this DALANG build (v${SCHEMA_VERSION}). Update DALANG.`,
    );
  }
  sqlite.exec(BOOTSTRAP_SQL);
  // Columns first: seeding and the data migrations below query the current schema.
  const upgrading = storedVersion > 0;
  if (upgrading && storedVersion < 4) addColumnsV4(sqlite);
  if (upgrading && storedVersion < 5) migrateToV5(sqlite);
  if (upgrading && storedVersion < 6) migrateToV6(sqlite);
  if (upgrading && storedVersion < 7) migrateToV7(sqlite);
  if (upgrading && storedVersion < 8) migrateToV8(sqlite);
  if (upgrading && storedVersion < 9) migrateToV9(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS message_images (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_images_message_id ON message_images(message_id);
  `);
  backfillLeadTurnsFromDisk(sqlite);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_working_per_project
      ON sessions(project_id)
      WHERE work_state = 'working';
  `);
  const db = drizzle(sqlite, { schema });
  dbDataDirs.set(db, dataDir);
  seedDefaults(db);
  refreshDefaultRolePrompts(db);
  if (storedVersion > 0 && storedVersion < 2) {
    migrateV1ToV2(db);
  }
  if (upgrading && storedVersion < 4) {
    seedReviewerRule(db);
  }
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);

  return {
    db,
    sqlite,
    dataDir,
    close: () => sqlite.close(),
  };
}
