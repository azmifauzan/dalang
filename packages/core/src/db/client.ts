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
  close: () => void;
}

const SCHEMA_VERSION = 1;

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
        complexity: 'high',
        profileId: 'profile-coder-heavy',
        fallbackProfileId: 'profile-lead',
      },
      {
        id: crypto.randomUUID(),
        sortOrder: 4,
        role: 'qa',
        complexity: null,
        profileId: 'profile-reviewer',
        fallbackProfileId: 'profile-lead',
      },
    ])
    .run();
}

export function openDatabase(dbFilePath: string = getDbPath()): DbConnection {
  if (dbFilePath !== ':memory:') {
    ensureDir(path.dirname(dbFilePath));
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
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  const db = drizzle(sqlite, { schema });
  seedDefaults(db);

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
