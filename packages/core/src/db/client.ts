import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ensureDir, getDbPath } from '../paths.js';
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

const SCHEMA_VERSION = 6;

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  cli_session_id TEXT,
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
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
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
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  role TEXT NOT NULL,
  complexity TEXT,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  fallback_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
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
  log_path TEXT NOT NULL,
  result_path TEXT,
  scope_warnings_json TEXT NOT NULL DEFAULT '[]'
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
      rolePrompt: 'Lead architect: clarify goals, author concise briefs, and decompose tasks with clear verify commands.',
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
      rolePrompt: 'Focused engineer for well-scoped, low-complexity tasks.',
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
      rolePrompt: 'Senior engineer for multi-file or high-complexity tasks.',
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
      rolePrompt: 'Independent reviewer verifying acceptance criteria and running test commands.',
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
        fallbackProfileId: null,
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 2,
        role: 'engineer',
        complexity: 'low',
        profileId: 'profile-coder-small',
        fallbackProfileId: 'profile-coder-heavy',
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 3,
        role: 'engineer',
        complexity: 'medium',
        profileId: 'profile-coder-heavy',
        fallbackProfileId: 'profile-lead',
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 4,
        role: 'engineer',
        complexity: 'high',
        profileId: 'profile-coder-heavy',
        fallbackProfileId: 'profile-lead',
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 5,
        role: 'qa',
        complexity: null,
        profileId: 'profile-reviewer',
        fallbackProfileId: 'profile-lead',
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 6,
        role: 'reviewer',
        complexity: null,
        profileId: 'profile-reviewer',
        fallbackProfileId: 'profile-lead',
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
          fallbackProfileId: lead && lead.id !== reviewer.id ? lead.id : null,
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
        fallbackProfileId: lead ? lead.id : null,
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
  const db = drizzle(sqlite, { schema });
  dbDataDirs.set(db, dataDir);
  seedDefaults(db);
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
