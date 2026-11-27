import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, resetDatabaseToDefaults } from '../db/client.js';

function getTableIndexColumns(sqlite: Database.Database, table: string): Map<string, string[]> {
  const list = sqlite.pragma(`index_list(${table})`) as Array<{ name: string }>;
  const map = new Map<string, string[]>();
  for (const idx of list) {
    const cols = (sqlite.pragma(`index_info(${idx.name})`) as Array<{ name: string | null }>)
      .map((c) => c.name)
      .filter((name): name is string => typeof name === 'string');
    map.set(idx.name, cols);
  }
  return map;
}

function expectV17PragmasAndFkIndexes(sqlite: Database.Database): void {
  expect(sqlite.pragma('user_version', { simple: true })).toBe(18);
  expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  expect(sqlite.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(sqlite.pragma('foreign_key_check')).toEqual([]);

  expect(getTableIndexColumns(sqlite, 'messages').get('idx_messages_session_id')).toEqual(['session_id']);
  expect(getTableIndexColumns(sqlite, 'sessions').get('idx_sessions_project_id')).toEqual(['project_id']);
  expect(getTableIndexColumns(sqlite, 'tasks').get('idx_tasks_plan_id')).toEqual(['plan_id']);
  expect(getTableIndexColumns(sqlite, 'runs').get('idx_runs_task_id')).toEqual(['task_id']);
  expect(getTableIndexColumns(sqlite, 'reviews').get('idx_reviews_task_id')).toEqual(['task_id']);
  expect(getTableIndexColumns(sqlite, 'tasks').get('idx_tasks_parent_client_request')).toEqual([
    'parent_task_id',
    'client_request_id',
  ]);
  expect(getTableIndexColumns(sqlite, 'automation_runs').get('idx_automation_runs_automation_delivery')).toEqual([
    'automation_id',
    'delivery_id',
  ]);

  const planDetail = (sql: string) =>
    (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('sample-id') as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' ');
  expect(planDetail('SELECT id FROM messages WHERE session_id = ?')).toContain('idx_messages_session_id');
  expect(planDetail('SELECT id FROM sessions WHERE project_id = ?')).toContain('idx_sessions_project_id');
  expect(planDetail('SELECT id FROM tasks WHERE plan_id = ?')).toContain('idx_tasks_plan_id');
  expect(planDetail('SELECT id FROM runs WHERE task_id = ?')).toContain('idx_runs_task_id');
  expect(planDetail('SELECT id FROM reviews WHERE task_id = ?')).toContain('idx_reviews_task_id');
}

describe('database upgrade', () => {
  it('opens a v3 database that lacks the v4 to v7 columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    const drop: Array<[string, string]> = [
      ['agent_profiles', 'max_review_rounds'],
      ['projects', 'integration_command'],
      ['projects', 'push_after_merge'],
      ['projects', 'create_pr_after_merge'],
      ['projects', 'git_remote'],
      ['tasks', 'branch_name'],
      ['tasks', 'merge_commit_sha'],
      ['tasks', 'rejection_note'],
      ['tasks', 'pr_url'],
      ['tasks', 'pushed_at'],
      ['runs', 'kind'],
      ['runs', 'branch_name'],
      ['runs', 'worktree_path'],
      ['runs', 'account_key'],
      ['runs', 'checkpoint_before_ref'],
      ['runs', 'checkpoint_after_ref'],
      ['runs', 'input_tokens'],
      ['runs', 'output_tokens'],
      ['runs', 'cache_read_tokens'],
      ['runs', 'cache_write_tokens'],
      ['runs', 'estimated_cost_usd'],
      ['runs', 'cost_source'],
      ['agent_profiles', 'fallback_profile_id'],
      ['agent_profiles', 'config_dir'],
      ['provider_events', 'account_key'],
    ];
    for (const [t, c] of drop) fresh.sqlite.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    fresh.sqlite.exec(`DELETE FROM routing_rules WHERE role = 'reviewer'`);
    fresh.sqlite.pragma('user_version = 3');
    fresh.close();

    const upgraded = openDatabase(file);
    expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);
    const runCols = (upgraded.sqlite.pragma('table_info(runs)') as Array<{ name: string }>).map((c) => c.name);
    expect(runCols).toContain('worktree_path');
    expect(runCols).toContain('input_tokens');
    expect(runCols).toContain('estimated_cost_usd');
    expect(runCols).toContain('checkpoint_before_ref');
    const profCols = (upgraded.sqlite.pragma('table_info(agent_profiles)') as Array<{ name: string }>).map((c) => c.name);
    expect(profCols).toContain('config_dir');
    const projCols = (upgraded.sqlite.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name);
    expect(projCols).toContain('push_after_merge');
    expect(projCols).toContain('create_pr_after_merge');
    expect(upgraded.sqlite.prepare(`SELECT count(*) n FROM routing_rules WHERE role = 'reviewer'`).get()).toEqual({ n: 1 });
    upgraded.close();
  });

  it('upgrades a v7 database: fallback profiles become targets and engineer tiers run low, medium, high', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up8-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    // Shape of a v7 database: fallbacks are profile ids, and medium was inserted after high.
    fresh.sqlite.exec(`
      UPDATE routing_rules SET fallback_provider = NULL, fallback_model = NULL, fallback_effort = NULL,
        fallback_config_dir = NULL;
      UPDATE routing_rules SET fallback_profile_id = 'profile-coder-small' WHERE role = 'engineer' AND complexity = 'high';
      UPDATE routing_rules SET sort_order = 3 WHERE role = 'engineer' AND complexity = 'high';
      UPDATE routing_rules SET sort_order = 4 WHERE role = 'engineer' AND complexity = 'medium';
      UPDATE agent_profiles SET fallback_provider = NULL, fallback_model = NULL, fallback_effort = NULL;
      UPDATE agent_profiles SET fallback_profile_id = 'profile-reviewer' WHERE id = 'profile-lead';
    `);
    fresh.sqlite.pragma('user_version = 7');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      const rules = upgraded.sqlite
        .prepare(`SELECT complexity, fallback_provider AS p, fallback_model AS m, fallback_effort AS e FROM routing_rules WHERE role = 'engineer' ORDER BY sort_order`)
        .all() as Array<{ complexity: string; p: string | null; m: string | null; e: string | null }>;
      expect(rules.map((r) => r.complexity)).toEqual(['low', 'medium', 'high']);
      // high pointed at executor-light (codex, low effort): the target keeps that CLI and effort.
      expect(rules.find((r) => r.complexity === 'high')).toMatchObject({ p: 'codex', e: 'low' });
      const lead = upgraded.sqlite.prepare(`SELECT fallback_provider AS p FROM agent_profiles WHERE id = 'profile-lead'`).get();
      expect(lead).toEqual({ p: 'antigravity' });
      const orders = upgraded.sqlite.prepare('SELECT sort_order FROM routing_rules ORDER BY sort_order').all() as Array<{ sort_order: number }>;
      expect(orders.map((o) => o.sort_order)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      upgraded.close();
    }
  });

  it('upgrades a v8 (v0.6) database to v9 with sessions, migrated .dalang artifacts, empty projects, and one-working index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up9-'));
    const file = path.join(dir, 'dalang.db');
    const projADir = path.join(dir, 'proj-a');
    const projBDir = path.join(dir, 'proj-b');
    const projCDir = path.join(dir, 'proj-c');

    // Seed legacy .dalang/ artifacts on disk for Project A (in-progress) and Project B (done)
    fs.mkdirSync(path.join(projADir, '.dalang', 'discuss'), { recursive: true });
    fs.mkdirSync(path.join(projADir, '.dalang', 'tasks', 'T-001'), { recursive: true });
    fs.mkdirSync(path.join(projADir, '.dalang', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(projADir, '.dalang', 'brief.v1.json'), JSON.stringify({ title: 'Auth feature' }));
    fs.writeFileSync(path.join(projADir, '.dalang', 'plan.v1.json'), JSON.stringify({ tasks: [] }));
    fs.writeFileSync(path.join(projADir, '.dalang', 'discuss', 'round-1.json'), JSON.stringify({ round: 1 }));
    fs.writeFileSync(path.join(projADir, '.dalang', 'tasks', 'T-001', 'result.json'), JSON.stringify({ status: 'completed' }));
    fs.writeFileSync(path.join(projADir, '.dalang', 'logs', 'run-1.log'), 'hello log');
    // A v0.6 repo: `.dalang/.gitignore` only ignores `tmp/`, plus one line the user added.
    fs.writeFileSync(path.join(projADir, '.dalang', '.gitignore'), 'tmp/\nmy-notes/');

    fs.mkdirSync(path.join(projBDir, '.dalang'), { recursive: true });
    fs.writeFileSync(path.join(projBDir, '.dalang', 'brief.v1.json'), JSON.stringify({ title: 'Done billing' }));
    fs.mkdirSync(path.join(projCDir, '.dalang'), { recursive: true });

    // Create a genuine v8-shaped SQLite database (no v9 columns, plans.brief_id NOT NULL, no partial index)
    const fresh = openDatabase(file);
    const now = '2026-01-10T10:00:00.000Z';
    fresh.sqlite.pragma('foreign_keys = OFF');
    fresh.sqlite.exec(`
      DROP INDEX IF EXISTS idx_sessions_one_working_per_project;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS plans;
      DROP TABLE IF EXISTS briefs;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        phase TEXT NOT NULL DEFAULT 'discuss',
        provider TEXT NOT NULL,
        model TEXT,
        cli_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE briefs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        file_path TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        brief_id TEXT NOT NULL REFERENCES briefs(id),
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        file_path TEXT NOT NULL,
        milestones TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        milestone TEXT NOT NULL,
        role TEXT NOT NULL,
        complexity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        position INTEGER NOT NULL,
        goal TEXT NOT NULL,
        files_allowed_json TEXT NOT NULL,
        files_reference_json TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
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
    `);

    const insertProj = fresh.sqlite.prepare(`
      INSERT INTO projects (id, name, path, main_branch, lead_provider, created_at, updated_at)
      VALUES (?, ?, ?, 'main', 'claude-code', ?, ?)
    `);
    insertProj.run('proj-a', 'Project A', projADir, now, now);
    insertProj.run('proj-b', 'Project B', projBDir, now, now);
    insertProj.run('proj-c', 'Project C', projCDir, now, now);

    // Project A: active discuss session + message + approved brief + approved plan + unmerged task
    fresh.sqlite
      .prepare(`INSERT INTO sessions (id, project_id, phase, provider, cli_session_id, created_at, updated_at) VALUES (?, ?, 'discuss', 'claude-code', 'cli-a', ?, ?)`)
      .run('sess-a', 'proj-a', now, now);
    fresh.sqlite
      .prepare(`INSERT INTO messages (id, session_id, role, type, content, created_at) VALUES (?, ?, 'user', 'text', ?, ?)`)
      .run('msg-a1', 'sess-a', JSON.stringify({ text: 'Build OAuth login' }), now);
    fresh.sqlite
      .prepare(`INSERT INTO briefs (id, project_id, version, status, file_path, content_json, created_at, approved_at) VALUES (?, ?, 1, 'approved', '.dalang/brief.v1.json', ?, ?, ?)`)
      .run('brief-a1', 'proj-a', JSON.stringify({ title: 'OAuth Login Brief', problem: 'Need login' }), now, now);
    fresh.sqlite
      .prepare(`INSERT INTO plans (id, project_id, brief_id, version, status, file_path, milestones, created_at, approved_at) VALUES (?, ?, ?, 1, 'approved', '.dalang/plan.v1.json', '[]', ?, ?)`)
      .run('plan-a1', 'proj-a', 'brief-a1', now, now);
    fresh.sqlite
      .prepare(`INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, branch_name, created_at, updated_at) VALUES (?, ?, 'T-001', 'Add login', 'M1', 'engineer', 'low', 'awaiting_merge', 0, 'Goal', '["src/auth.ts"]', '[]', '["Works"]', 'npm test', 'dalang/T-001', ?, ?)`)
      .run('task-a1', 'plan-a1', now, now);

    // Project B: completed project (brief + plan + merged task, no prior session row)
    fresh.sqlite
      .prepare(`INSERT INTO briefs (id, project_id, version, status, file_path, content_json, created_at, approved_at) VALUES (?, ?, 1, 'approved', '.dalang/brief.v1.json', ?, ?, ?)`)
      .run('brief-b1', 'proj-b', JSON.stringify({ title: 'Billing Export', problem: 'Export CSV' }), now, now);
    fresh.sqlite
      .prepare(`INSERT INTO plans (id, project_id, brief_id, version, status, file_path, milestones, created_at, approved_at) VALUES (?, ?, ?, 1, 'approved', '.dalang/plan.v1.json', '[]', ?, ?)`)
      .run('plan-b1', 'proj-b', 'brief-b1', now, now);
    fresh.sqlite
      .prepare(`INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, merge_commit_sha, created_at, updated_at) VALUES (?, ?, 'T-001', 'Export CSV', 'M1', 'engineer', 'low', 'done', 0, 'Goal', '["src/csv.ts"]', '[]', '["Works"]', 'npm test', 'abc1234', ?, ?)`)
      .run('task-b1', 'plan-b1', now, now);

    // Project C: empty project with an orphan empty session (should be removed -> 0 sessions)
    fresh.sqlite
      .prepare(`INSERT INTO sessions (id, project_id, phase, provider, created_at, updated_at) VALUES (?, ?, 'discuss', 'claude-code', ?, ?)`)
      .run('sess-c-orphan', 'proj-c', now, now);

    fresh.sqlite.pragma('foreign_keys = ON');
    fresh.sqlite.pragma('user_version = 8');
    fresh.close();

    // Open and trigger v8 -> v9 upgrade
    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);

      // Project A: 1 Full working session preserving brief, plan, tasks, messages, and moved artifacts
      const sessionsA = upgraded.sqlite
        .prepare(`SELECT id, title, mode, work_state, phase, cli_session_id FROM sessions WHERE project_id = 'proj-a'`)
        .all() as Array<{ id: string; title: string; mode: string; work_state: string; phase: string; cli_session_id: string | null }>;
      expect(sessionsA).toHaveLength(1);
      expect(sessionsA[0]).toMatchObject({
        id: 'sess-a',
        title: 'Auth feature',
        mode: 'full',
        work_state: 'working',
        phase: 'run',
        cli_session_id: 'cli-a',
      });

      const briefA = upgraded.sqlite.prepare(`SELECT session_id, file_path FROM briefs WHERE id = 'brief-a1'`).get() as { session_id: string; file_path: string };
      expect(briefA.session_id).toBe('sess-a');
      expect(briefA.file_path).toBe('.dalang/sessions/sess-a/brief.v1.json');

      const planA = upgraded.sqlite.prepare(`SELECT session_id, brief_id, file_path FROM plans WHERE id = 'plan-a1'`).get() as { session_id: string; brief_id: string | null; file_path: string };
      expect(planA.session_id).toBe('sess-a');
      expect(planA.brief_id).toBe('brief-a1');
      expect(planA.file_path).toBe('.dalang/sessions/sess-a/plan.v1.json');

      const msgCountA = upgraded.sqlite.prepare(`SELECT count(*) n FROM messages WHERE session_id = 'sess-a'`).get() as { n: number };
      expect(msgCountA.n).toBe(1);

      // Verify files moved on disk into .dalang/sessions/sess-a/
      expect(fs.existsSync(path.join(projADir, '.dalang', 'sessions', 'sess-a', 'brief.v1.json'))).toBe(true);
      expect(fs.existsSync(path.join(projADir, '.dalang', 'sessions', 'sess-a', 'plan.v1.json'))).toBe(true);
      expect(fs.existsSync(path.join(projADir, '.dalang', 'sessions', 'sess-a', 'discuss', 'round-1.json'))).toBe(true);
      expect(fs.existsSync(path.join(projADir, '.dalang', 'sessions', 'sess-a', 'tasks', 'T-001', 'result.json'))).toBe(true);
      expect(fs.existsSync(path.join(projADir, '.dalang', 'sessions', 'sess-a', 'logs', 'run-1.log'))).toBe(true);
      expect(fs.existsSync(path.join(projADir, '.dalang', 'brief.v1.json'))).toBe(false);

      // The old ignore file gains the session entries and keeps the user's own line
      const ignoreA = fs.readFileSync(path.join(projADir, '.dalang', '.gitignore'), 'utf8').split('\n');
      expect(ignoreA).toEqual(expect.arrayContaining(['tmp/', 'my-notes/', 'sessions/*/tmp/', 'sessions/*/logs/']));
      expect(ignoreA.filter((l) => l === 'tmp/')).toHaveLength(1);

      // Project B: 1 Full idle session titled from brief
      const sessionsB = upgraded.sqlite
        .prepare(`SELECT id, title, mode, work_state, phase FROM sessions WHERE project_id = 'proj-b'`)
        .all() as Array<{ id: string; title: string; mode: string; work_state: string; phase: string }>;
      expect(sessionsB).toHaveLength(1);
      expect(sessionsB[0]).toMatchObject({
        title: 'Done billing',
        mode: 'full',
        work_state: 'idle',
      });
      const briefB = upgraded.sqlite.prepare(`SELECT session_id, file_path FROM briefs WHERE id = 'brief-b1'`).get() as { session_id: string; file_path: string };
      expect(briefB.session_id).toBe(sessionsB[0].id);
      expect(fs.existsSync(path.join(projBDir, '.dalang', 'sessions', sessionsB[0].id, 'brief.v1.json'))).toBe(true);

      // Project C: 0 sessions (empty orphan deleted)
      const sessionsC = upgraded.sqlite.prepare(`SELECT id FROM sessions WHERE project_id = 'proj-c'`).all();
      expect(sessionsC).toHaveLength(0);

      // plans.brief_id is now nullable (Quick mode)
      upgraded.sqlite
        .prepare(`INSERT INTO plans (id, project_id, session_id, brief_id, version, status, file_path, created_at) VALUES ('plan-quick', 'proj-b', ?, NULL, 2, 'draft', '.dalang/sessions/x/plan.v2.json', ?)`)
        .run(sessionsB[0].id, now);
      const quickPlan = upgraded.sqlite.prepare(`SELECT brief_id FROM plans WHERE id = 'plan-quick'`).get() as { brief_id: string | null };
      expect(quickPlan.brief_id).toBeNull();

      // Partial unique index allows multiple idle sessions, allows working in another project,
      // and rejects a second working session in the same project (proj-a already has sess-a working).
      expect(() => {
        upgraded.sqlite
          .prepare(`INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, created_at, updated_at) VALUES ('sess-a-dup', 'proj-a', 'Second', 'quick', 'working', 'work', 'claude-code', ?, ?)`)
          .run(now, now);
      }).toThrow(/UNIQUE constraint failed/);

      // Second idle session in proj-a is allowed
      upgraded.sqlite
        .prepare(`INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, created_at, updated_at) VALUES ('sess-a-idle', 'proj-a', 'Ask chat', 'ask', 'idle', 'ask', 'claude-code', ?, ?)`)
        .run(now, now);

      // Working session in proj-b is allowed even while proj-a has a working session
      upgraded.sqlite
        .prepare(`UPDATE sessions SET work_state = 'working' WHERE id = ?`)
        .run(sessionsB[0].id);
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v10 database to v11 by provisioning the medium executor and checker profiles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up11-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    // Simulate a v10 database that only had the 4 original profiles and shared rules.
    fresh.sqlite.exec(`
      UPDATE routing_rules SET profile_id = 'profile-coder-heavy' WHERE role = 'engineer' AND complexity = 'medium';
      UPDATE routing_rules SET profile_id = 'profile-reviewer' WHERE role = 'qa';
      DELETE FROM agent_profiles WHERE id IN ('profile-coder-medium', 'profile-qa');
    `);
    fresh.sqlite.pragma('user_version = 10');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);
      const names = (
        upgraded.sqlite.prepare('SELECT name FROM agent_profiles ORDER BY name').all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names).toEqual(['checker', 'executor-heavy', 'executor-light', 'executor-medium', 'lead', 'reviewer']);

      const mediumRule = upgraded.sqlite
        .prepare(`SELECT profile_id AS id FROM routing_rules WHERE role = 'engineer' AND complexity = 'medium'`)
        .get() as { id: string };
      expect(mediumRule.id).toBe('profile-coder-medium');

      const qaRule = upgraded.sqlite
        .prepare(`SELECT profile_id AS id FROM routing_rules WHERE role = 'qa'`)
        .get() as { id: string };
      expect(qaRule.id).toBe('profile-qa');
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v11 database to v12+ by adding task delegation columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up12-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    fresh.sqlite.exec(`
      ALTER TABLE tasks DROP COLUMN delegated_by_run_id;
      ALTER TABLE tasks DROP COLUMN delegation_depth;
      ALTER TABLE tasks DROP COLUMN merge_target_branch;
    `);
    fresh.sqlite.pragma('user_version = 11');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);
      const taskCols = (upgraded.sqlite.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      expect(taskCols).toContain('delegated_by_run_id');
      expect(taskCols).toContain('delegation_depth');
      expect(taskCols).toContain('merge_target_branch');
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v12 database to v13 by creating task_repos and run_repo_checkpoints', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up13-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    fresh.sqlite.exec(`
      DROP TABLE IF EXISTS run_repo_checkpoints;
      DROP TABLE IF EXISTS task_repos;
    `);
    fresh.sqlite.pragma('user_version = 12');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);
      const taskRepoCols = (
        upgraded.sqlite.pragma('table_info(task_repos)') as Array<{ name: string }>
      ).map((c) => c.name);
      expect(taskRepoCols).toEqual(
        expect.arrayContaining([
          'id',
          'task_id',
          'repo_path',
          'base_branch',
          'base_sha',
          'branch_name',
          'worktree_path',
          'merge_commit_sha',
          'pr_url',
          'pushed_at',
        ]),
      );
      const cpCols = (
        upgraded.sqlite.pragma('table_info(run_repo_checkpoints)') as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cpCols).toEqual(
        expect.arrayContaining([
          'id',
          'run_id',
          'repo_path',
          'commit_before',
          'commit_after',
          'checkpoint_before_ref',
          'checkpoint_after_ref',
        ]),
      );
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v13 database to v14 by creating automations, automation_runs, and mcp_tokens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up14-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    fresh.sqlite.exec(`
      DROP TABLE IF EXISTS webhook_deliveries;
      DROP TABLE IF EXISTS automation_runs;
      DROP TABLE IF EXISTS automations;
      DROP TABLE IF EXISTS mcp_tokens;
    `);
    fresh.sqlite.pragma('user_version = 13');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);
      const autoCols = (
        upgraded.sqlite.pragma('table_info(automations)') as Array<{ name: string }>
      ).map((c) => c.name);
      expect(autoCols).toEqual(
        expect.arrayContaining([
          'id',
          'project_id',
          'kind',
          'cron_expr',
          'webhook_token',
          'webhook_secret',
          'auto_merge',
          'next_run_at',
        ]),
      );
      const runCols = (
        upgraded.sqlite.pragma('table_info(automation_runs)') as Array<{ name: string }>
      ).map((c) => c.name);
      expect(runCols).toEqual(
        expect.arrayContaining(['id', 'automation_id', 'trigger_source', 'session_id', 'task_id', 'status']),
      );
      const tokenCols = (
        upgraded.sqlite.pragma('table_info(mcp_tokens)') as Array<{ name: string }>
      ).map((c) => c.name);
      expect(tokenCols).toEqual(
        expect.arrayContaining(['id', 'name', 'access_level', 'token_prefix', 'token_hash', 'project_id', 'revoked_at']),
      );
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v14 database to v15 by adding author_profile_id and kind to messages and backfilling kinds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up15-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    const now = '2026-11-24T00:00:00.000Z';
    fresh.sqlite.exec(`
      INSERT INTO projects (id, name, path, main_branch, lead_provider, created_at, updated_at)
      VALUES ('p1', 'demo', '${path.join(dir, 'repo').replace(/'/g, "''")}', 'main', 'claude-code', '${now}', '${now}');
      INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, created_at, updated_at)
      VALUES ('s1', 'p1', 'chat', 'full', 'idle', 'discuss', 'claude-code', '${now}', '${now}');
      INSERT INTO messages (id, session_id, role, type, content, created_at) VALUES
        ('m-user', 's1', 'user', 'text', 'hello', '${now}'),
        ('m-q', 's1', 'lead', 'questions', '{"round":1}', '${now}'),
        ('m-brief', 's1', 'lead', 'brief', '{"version":1}', '${now}'),
        ('m-err', 's1', 'system', 'error', 'boom', '${now}');
      ALTER TABLE messages DROP COLUMN kind;
      ALTER TABLE messages DROP COLUMN author_profile_id;
    `);
    fresh.sqlite.pragma('user_version = 14');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);
      const msgCols = (
        upgraded.sqlite.pragma('table_info(messages)') as Array<{ name: string }>
      ).map((c) => c.name);
      expect(msgCols).toEqual(expect.arrayContaining(['author_profile_id', 'kind']));

      const rows = upgraded.sqlite
        .prepare('SELECT id, kind, author_profile_id FROM messages ORDER BY id')
        .all() as Array<{ id: string; kind: string; author_profile_id: string | null }>;
      expect(rows).toEqual([
        { id: 'm-brief', kind: 'gate', author_profile_id: 'profile-lead' },
        { id: 'm-err', kind: 'status', author_profile_id: null },
        { id: 'm-q', kind: 'question', author_profile_id: 'profile-lead' },
        { id: 'm-user', kind: 'chat', author_profile_id: null },
      ]);
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v15 database to v16: keeps existing rows, adds output_kind, allows null verify, and refreshes untouched v0.13 prompts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up16-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    const now = '2026-11-25T00:00:00.000Z';

    fresh.sqlite.pragma('foreign_keys = OFF');
    fresh.sqlite.exec(`
      DROP TABLE IF EXISTS reviews;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS automations;

      CREATE TABLE tasks (
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
        delegated_by_run_id TEXT,
        delegation_depth INTEGER NOT NULL DEFAULT 0,
        merge_target_branch TEXT,
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

      CREATE TABLE reviews (
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

      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expr TEXT,
        webhook_token TEXT UNIQUE,
        webhook_secret TEXT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'engineer',
        complexity TEXT NOT NULL DEFAULT 'low',
        files_allowed_json TEXT NOT NULL DEFAULT '[]',
        files_reference_json TEXT NOT NULL DEFAULT '[]',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        verify TEXT NOT NULL,
        profile_override TEXT,
        allow_unconfined INTEGER NOT NULL DEFAULT 0,
        auto_merge INTEGER NOT NULL DEFAULT 0,
        last_triggered_at TEXT,
        next_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    fresh.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, main_branch, lead_provider, created_at, updated_at)
         VALUES ('p16', 'v15-proj', ?, 'main', 'claude-code', ?, ?)`,
      )
      .run(path.join(dir, 'repo'), now, now);
    fresh.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, created_at, updated_at)
         VALUES ('s16', 'p16', 'Work', 'quick', 'idle', 'work', 'claude-code', ?, ?)`,
      )
      .run(now, now);
    fresh.sqlite
      .prepare(
        `INSERT INTO plans (id, project_id, session_id, brief_id, version, status, file_path, created_at)
         VALUES ('plan16', 'p16', 's16', NULL, 1, 'approved', '.dalang/sessions/s16/plan.json', ?)`,
      )
      .run(now);
    fresh.sqlite
      .prepare(
        `INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
         VALUES ('t-old', 'plan16', 'T-001', 'Old task', 'M1', 'engineer', 'low', 'done', 0, 'Goal', '["src/a.ts"]', '[]', '["Passes"]', 'pnpm test', ?, ?)`,
      )
      .run(now, now);
    fresh.sqlite
      .prepare(
        `INSERT INTO runs (id, project_id, task_id, profile_id, provider, kind, status, log_path, started_at, finished_at)
         VALUES ('run-old', 'p16', 't-old', 'profile-reviewer', 'codex', 'review', 'completed', '.dalang/logs/run-old.log', ?, ?)`,
      )
      .run(now, now);
    fresh.sqlite
      .prepare(
        `INSERT INTO reviews (id, project_id, task_id, run_id, round, status, reviewer_profile_id, reviewer_provider, verify_command, verify_exit_code, verify_output, file_path, scope_warnings_json, created_at)
         VALUES ('rev-old', 'p16', 't-old', 'run-old', 1, 'pass', 'profile-reviewer', 'codex', 'pnpm test', 0, 'ok', '.dalang/tasks/T-001/review-1.json', '[]', ?)`,
      )
      .run(now);
    fresh.sqlite
      .prepare(
        `INSERT INTO automations (id, project_id, name, kind, enabled, cron_expr, title, prompt, role, complexity, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
         VALUES ('auto-old', 'p16', 'Nightly', 'schedule', 1, '0 2 * * *', 'Check', 'Run check', 'engineer', 'low', '[]', '[]', '["OK"]', 'pnpm test', ?, ?)`,
      )
      .run(now, now);

    // Put v0.13 seeded prompt on profile-qa and a custom prompt on profile-reviewer
    const v13QaPrompt =
      'You are a quality assurance engineer focused on verification, regression checks, and test coverage.\n- Read PROJECT.md, acceptance criteria, and the relevant implementation before writing or running tests.\n- Stay within files_allowed and verify edge cases, failure paths, and expected outputs with real test commands rather than assumptions.\n- Report concrete pass/fail command outputs and any uncovered risk clearly.';
    fresh.sqlite.prepare('UPDATE agent_profiles SET role_prompt = ? WHERE id = ?').run(v13QaPrompt, 'profile-qa');
    fresh.sqlite
      .prepare('UPDATE agent_profiles SET role_prompt = ? WHERE id = ?')
      .run('Custom reviewer rules stay.', 'profile-reviewer');

    fresh.sqlite.pragma('foreign_keys = ON');
    fresh.sqlite.pragma('user_version = 15');
    fresh.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(18);

      const oldTask = upgraded.sqlite
        .prepare(`SELECT external_id, output_kind, verify FROM tasks WHERE id = 't-old'`)
        .get() as { external_id: string; output_kind: string; verify: string | null };
      expect(oldTask).toEqual({ external_id: 'T-001', output_kind: 'files', verify: 'pnpm test' });

      const oldReview = upgraded.sqlite
        .prepare(`SELECT verify_command, verify_exit_code FROM reviews WHERE id = 'rev-old'`)
        .get() as { verify_command: string | null; verify_exit_code: number | null };
      expect(oldReview).toEqual({ verify_command: 'pnpm test', verify_exit_code: 0 });

      const oldAuto = upgraded.sqlite
        .prepare(`SELECT output_kind, verify FROM automations WHERE id = 'auto-old'`)
        .get() as { output_kind: string; verify: string | null };
      expect(oldAuto).toEqual({ output_kind: 'files', verify: 'pnpm test' });

      // Insert a new answer task with NULL verify, a NULL-verify review, and a NULL-verify automation
      upgraded.sqlite
        .prepare(
          `INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, output_kind, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
           VALUES ('t-ans', 'plan16', 'T-002', 'Answer task', 'M1', 'engineer', 'low', 'answer', 'ready', 1, 'Summarize', '[]', '[]', '["Clear summary"]', NULL, ?, ?)`,
        )
        .run(now, now);
      upgraded.sqlite
        .prepare(
          `INSERT INTO runs (id, project_id, task_id, profile_id, provider, kind, status, log_path, started_at, finished_at)
           VALUES ('run-ans', 'p16', 't-ans', 'profile-reviewer', 'codex', 'review', 'completed', '.dalang/logs/run-ans.log', ?, ?)`,
        )
        .run(now, now);
      upgraded.sqlite
        .prepare(
          `INSERT INTO reviews (id, project_id, task_id, run_id, round, status, reviewer_profile_id, reviewer_provider, verify_command, verify_exit_code, verify_output, file_path, scope_warnings_json, created_at)
           VALUES ('rev-ans', 'p16', 't-ans', 'run-ans', 1, 'pass', 'profile-reviewer', 'codex', NULL, NULL, '', '.dalang/tasks/T-002/review-1.json', '[]', ?)`,
        )
        .run(now);
      upgraded.sqlite
        .prepare(
          `INSERT INTO automations (id, project_id, name, kind, enabled, cron_expr, title, prompt, role, complexity, output_kind, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
           VALUES ('auto-ans', 'p16', 'Weekly digest', 'schedule', 1, '0 9 * * 1', 'Digest', 'Write digest', 'engineer', 'low', 'answer', '[]', '[]', '["Covers last week"]', NULL, ?, ?)`,
        )
        .run(now, now);

      const ansTask = upgraded.sqlite
        .prepare(`SELECT output_kind, verify FROM tasks WHERE id = 't-ans'`)
        .get() as { output_kind: string; verify: string | null };
      expect(ansTask).toEqual({ output_kind: 'answer', verify: null });

      const ansRev = upgraded.sqlite
        .prepare(`SELECT verify_command, verify_exit_code FROM reviews WHERE id = 'rev-ans'`)
        .get() as { verify_command: string | null; verify_exit_code: number | null };
      expect(ansRev).toEqual({ verify_command: null, verify_exit_code: null });

      // Untouched v0.13 prompt was refreshed to neutral wording; custom prompt stayed untouched
      const qaPrompt = (
        upgraded.sqlite.prepare(`SELECT role_prompt AS p FROM agent_profiles WHERE id = 'profile-qa'`).get() as {
          p: string;
        }
      ).p;
      expect(qaPrompt).toContain('You are a checker focused on verification');
      const revPrompt = (
        upgraded.sqlite.prepare(`SELECT role_prompt AS p FROM agent_profiles WHERE id = 'profile-reviewer'`).get() as {
          p: string;
        }
      ).p;
      expect(revPrompt).toBe('Custom reviewer rules stay.');
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a fresh v17 database with pragmas, foreign-key indexes, and idempotency storage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-fresh17-'));
    const file = path.join(dir, 'dalang.db');
    const now = '2026-11-26T00:00:00.000Z';

    const fresh = openDatabase(file);
    try {
      expectV17PragmasAndFkIndexes(fresh.sqlite);

      const taskCols = (fresh.sqlite.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      expect(taskCols).toContain('client_request_id');
      const autoRunCols = (fresh.sqlite.pragma('table_info(automation_runs)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(autoRunCols).toContain('delivery_id');
      const deliveryCols = (fresh.sqlite.pragma('table_info(webhook_deliveries)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(deliveryCols).toEqual(['automation_id', 'delivery_id', 'automation_run_id', 'received_at', 'expires_at']);

      // Seed synthetic data to exercise delegation & webhook idempotency constraints and resetDatabaseToDefaults.
      fresh.sqlite
        .prepare(
          `INSERT INTO projects (id, name, path, main_branch, lead_provider, created_at, updated_at)
           VALUES ('p17-fresh', 'Fresh17', ?, 'main', 'claude-code', ?, ?)`,
        )
        .run(path.join(dir, 'repo'), now, now);
      fresh.sqlite
        .prepare(
          `INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, created_at, updated_at)
           VALUES ('s17-fresh', 'p17-fresh', 'Chat', 'quick', 'idle', 'work', 'claude-code', ?, ?)`,
        )
        .run(now, now);
      fresh.sqlite
        .prepare(
          `INSERT INTO plans (id, project_id, session_id, brief_id, version, status, file_path, created_at)
           VALUES ('plan17-fresh', 'p17-fresh', 's17-fresh', NULL, 1, 'approved', '.dalang/sessions/s17-fresh/plan.json', ?)`,
        )
        .run(now);
      fresh.sqlite
        .prepare(
          `INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, output_kind, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
           VALUES
             ('parent-1', 'plan17-fresh', 'T-001', 'Parent 1', 'M1', 'engineer', 'medium', 'files', 'running', 0, 'Goal', '[]', '[]', '[]', NULL, ?, ?),
             ('parent-2', 'plan17-fresh', 'T-002', 'Parent 2', 'M1', 'engineer', 'medium', 'files', 'running', 1, 'Goal', '[]', '[]', '[]', NULL, ?, ?)`,
        )
        .run(now, now, now, now);

      const insertSubtask = fresh.sqlite.prepare(
        `INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, output_kind, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, parent_task_id, client_request_id, delegation_depth, created_at, updated_at)
         VALUES (?, 'plan17-fresh', ?, 'Sub', 'M1', 'engineer', 'low', 'files', 'ready', 2, 'Sub goal', '[]', '[]', '[]', NULL, ?, ?, 1, ?, ?)`,
      );
      // Multiple NULL client_request_id under the same parent are allowed.
      insertSubtask.run('sub-null-1', 'T-001.1', 'parent-1', null, now, now);
      insertSubtask.run('sub-null-2', 'T-001.2', 'parent-1', null, now, now);
      // Same client_request_id under different parents is allowed.
      insertSubtask.run('sub-req-a', 'T-001.3', 'parent-1', 'req-1', now, now);
      insertSubtask.run('sub-req-b', 'T-002.1', 'parent-2', 'req-1', now, now);
      // Duplicate (parent_task_id, client_request_id) is rejected.
      expect(() => insertSubtask.run('sub-req-dup', 'T-001.4', 'parent-1', 'req-1', now, now)).toThrow(
        /UNIQUE constraint failed/,
      );

      // Webhook deliveries primary key and foreign key actions.
      fresh.sqlite
        .prepare(
          `INSERT INTO automations (id, project_id, name, kind, enabled, webhook_token, webhook_secret, title, prompt, role, complexity, output_kind, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
           VALUES
             ('auto-1', 'p17-fresh', 'Hook 1', 'webhook', 1, 'tok-1', 'sec-1', 'T1', 'P1', 'engineer', 'low', 'files', '[]', '[]', '[]', NULL, ?, ?),
             ('auto-2', 'p17-fresh', 'Hook 2', 'webhook', 1, 'tok-2', 'sec-2', 'T2', 'P2', 'engineer', 'low', 'files', '[]', '[]', '[]', NULL, ?, ?)`,
        )
        .run(now, now, now, now);
      fresh.sqlite
        .prepare(
          `INSERT INTO automation_runs (id, automation_id, project_id, trigger_source, delivery_id, status, triggered_at)
           VALUES ('arun-1', 'auto-1', 'p17-fresh', 'webhook', 'deliv-abc', 'running', ?)`,
        )
        .run(now);
      const insertDelivery = fresh.sqlite.prepare(
        `INSERT INTO webhook_deliveries (automation_id, delivery_id, automation_run_id, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertDelivery.run('auto-1', 'deliv-abc', 'arun-1', now, null);
      // Same delivery_id on a different automation is allowed.
      insertDelivery.run('auto-2', 'deliv-abc', null, now, null);
      // Duplicate (automation_id, delivery_id) is rejected.
      expect(() => insertDelivery.run('auto-1', 'deliv-abc', null, now, null)).toThrow(/UNIQUE constraint failed/);

      // Deleting the automation_run sets automation_run_id to NULL; deleting the automation cascades.
      fresh.sqlite.prepare(`DELETE FROM automation_runs WHERE id = 'arun-1'`).run();
      expect(
        fresh.sqlite
          .prepare(`SELECT automation_run_id FROM webhook_deliveries WHERE automation_id = 'auto-1' AND delivery_id = 'deliv-abc'`)
          .get(),
      ).toEqual({ automation_run_id: null });
      fresh.sqlite.prepare(`DELETE FROM automations WHERE id = 'auto-1'`).run();
      expect(
        fresh.sqlite.prepare(`SELECT count(*) AS n FROM webhook_deliveries WHERE automation_id = 'auto-1'`).get(),
      ).toEqual({ n: 0 });
      expect(fresh.sqlite.pragma('foreign_key_check')).toEqual([]);

      // resetDatabaseToDefaults clears webhook_deliveries cleanly.
      resetDatabaseToDefaults(fresh.db, fresh.sqlite);
      expect(fresh.sqlite.prepare(`SELECT count(*) AS n FROM webhook_deliveries`).get()).toEqual({ n: 0 });
      expect(fresh.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      fresh.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a v16 database to v17: adds FK indexes, idempotency storage, pragmas, preserves data, passes FK checks, and reopens safely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up17-'));
    const file = path.join(dir, 'dalang.db');
    const now = '2026-11-26T00:00:00.000Z';

    // Build a genuine v16-shaped synthetic database (without v17 indexes, columns, or webhook_deliveries).
    const v16 = openDatabase(file);
    v16.sqlite.exec(`
      DROP INDEX IF EXISTS idx_messages_session_id;
      DROP INDEX IF EXISTS idx_sessions_project_id;
      DROP INDEX IF EXISTS idx_tasks_plan_id;
      DROP INDEX IF EXISTS idx_runs_task_id;
      DROP INDEX IF EXISTS idx_reviews_task_id;
      DROP INDEX IF EXISTS idx_tasks_parent_client_request;
      DROP INDEX IF EXISTS idx_automation_runs_automation_delivery;
      DROP INDEX IF EXISTS idx_webhook_deliveries_expires_at;
      DROP TABLE IF EXISTS webhook_deliveries;
      ALTER TABLE tasks DROP COLUMN client_request_id;
      ALTER TABLE automation_runs DROP COLUMN delivery_id;
    `);

    v16.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, main_branch, lead_provider, created_at, updated_at)
         VALUES ('p17', 'v16-proj', ?, 'main', 'claude-code', ?, ?)`,
      )
      .run(path.join(dir, 'repo'), now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, mode, work_state, phase, provider, created_at, updated_at)
         VALUES ('s17', 'p17', 'Existing work', 'full', 'idle', 'run', 'claude-code', ?, ?)`,
      )
      .run(now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO messages (id, session_id, role, type, kind, content, created_at)
         VALUES ('m17', 's17', 'user', 'text', 'chat', 'Keep this message', ?)`,
      )
      .run(now);
    v16.sqlite
      .prepare(
        `INSERT INTO briefs (id, project_id, session_id, version, status, file_path, created_at, approved_at)
         VALUES ('b17', 'p17', 's17', 1, 'approved', '.dalang/sessions/s17/brief.v1.json', ?, ?)`,
      )
      .run(now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO plans (id, project_id, session_id, brief_id, version, status, file_path, created_at, approved_at)
         VALUES ('plan17', 'p17', 's17', 'b17', 1, 'approved', '.dalang/sessions/s17/plan.v1.json', ?, ?)`,
      )
      .run(now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, output_kind, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
         VALUES ('t17', 'plan17', 'T-001', 'Existing task', 'M1', 'engineer', 'low', 'files', 'done', 0, 'Keep me', '["src/a.ts"]', '[]', '["Passes"]', 'pnpm test', ?, ?)`,
      )
      .run(now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO runs (id, project_id, task_id, profile_id, provider, kind, status, log_path, started_at, finished_at)
         VALUES ('run17', 'p17', 't17', 'profile-coder-small', 'codex', 'execute', 'completed', '.dalang/sessions/s17/logs/run17.log', ?, ?)`,
      )
      .run(now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO reviews (id, project_id, task_id, run_id, round, status, reviewer_profile_id, reviewer_provider, verify_command, verify_exit_code, verify_output, file_path, scope_warnings_json, created_at)
         VALUES ('rev17', 'p17', 't17', 'run17', 1, 'pass', 'profile-reviewer', 'claude-code', 'pnpm test', 0, 'ok', '.dalang/sessions/s17/tasks/T-001/review-1.json', '[]', ?)`,
      )
      .run(now);
    v16.sqlite
      .prepare(
        `INSERT INTO automations (id, project_id, name, kind, enabled, webhook_token, webhook_secret, title, prompt, role, complexity, output_kind, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, created_at, updated_at)
         VALUES ('auto17', 'p17', 'Deploy hook', 'webhook', 1, 'tok-v16', 'sec-v16', 'Handle hook', 'Run hook', 'engineer', 'low', 'files', '[]', '[]', '["OK"]', NULL, ?, ?)`,
      )
      .run(now, now);
    v16.sqlite
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, project_id, trigger_source, session_id, task_id, status, detail, triggered_at, finished_at)
         VALUES ('arun17', 'auto17', 'p17', 'webhook', 's17', 't17', 'completed', 'delivery:legacy-1', ?, ?)`,
      )
      .run(now, now);
    v16.sqlite.pragma('user_version = 16');
    v16.close();

    // First open: upgrades v16 -> v17.
    const upgraded = openDatabase(file);
    try {
      expectV17PragmasAndFkIndexes(upgraded.sqlite);

      // All synthetic v16 data is preserved with nullable additive columns defaulted to NULL.
      expect(upgraded.sqlite.prepare(`SELECT id, content FROM messages WHERE session_id = 's17'`).all()).toEqual([
        { id: 'm17', content: 'Keep this message' },
      ]);
      expect(upgraded.sqlite.prepare(`SELECT id, title FROM sessions WHERE project_id = 'p17'`).all()).toEqual([
        { id: 's17', title: 'Existing work' },
      ]);
      expect(
        upgraded.sqlite.prepare(`SELECT id, external_id, client_request_id FROM tasks WHERE plan_id = 'plan17'`).all(),
      ).toEqual([{ id: 't17', external_id: 'T-001', client_request_id: null }]);
      expect(upgraded.sqlite.prepare(`SELECT id, status FROM runs WHERE task_id = 't17'`).all()).toEqual([
        { id: 'run17', status: 'completed' },
      ]);
      expect(upgraded.sqlite.prepare(`SELECT id, status FROM reviews WHERE task_id = 't17'`).all()).toEqual([
        { id: 'rev17', status: 'pass' },
      ]);
      expect(
        upgraded.sqlite.prepare(`SELECT id, detail, delivery_id FROM automation_runs WHERE id = 'arun17'`).get(),
      ).toEqual({ id: 'arun17', detail: 'delivery:legacy-1', delivery_id: null });

      // Idempotency storage is usable immediately after upgrade.
      upgraded.sqlite
        .prepare(
          `INSERT INTO tasks (id, plan_id, external_id, title, milestone, role, complexity, output_kind, status, position, goal, files_allowed_json, files_reference_json, acceptance_criteria_json, verify, parent_task_id, client_request_id, delegation_depth, created_at, updated_at)
           VALUES ('t17-sub', 'plan17', 'T-001.1', 'Delegated', 'M1', 'engineer', 'low', 'files', 'ready', 1, 'Sub', '[]', '[]', '[]', NULL, 't17', 'req-42', 1, ?, ?)`,
        )
        .run(now, now);
      upgraded.sqlite
        .prepare(
          `INSERT INTO webhook_deliveries (automation_id, delivery_id, automation_run_id, received_at, expires_at)
           VALUES ('auto17', 'deliv-v17', 'arun17', ?, NULL)`,
        )
        .run(now);
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      upgraded.close();
    }

    // Reopen upgraded v17 database: idempotent, pragmas active, data and FK integrity intact.
    const reopened = openDatabase(file);
    try {
      expectV17PragmasAndFkIndexes(reopened.sqlite);
      expect(
        reopened.sqlite
          .prepare(`SELECT id, client_request_id FROM tasks WHERE parent_task_id = 't17' AND client_request_id = 'req-42'`)
          .get(),
      ).toEqual({ id: 't17-sub', client_request_id: 'req-42' });
      expect(
        reopened.sqlite
          .prepare(`SELECT automation_run_id FROM webhook_deliveries WHERE automation_id = 'auto17' AND delivery_id = 'deliv-v17'`)
          .get(),
      ).toEqual({ automation_run_id: 'arun17' });
      expect(reopened.sqlite.prepare(`SELECT count(*) AS n FROM messages WHERE session_id = 's17'`).get()).toEqual({
        n: 1,
      });
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
