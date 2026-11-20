import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/client.js';

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
    expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(9);
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
      // high pointed at coder-small (codex, low effort): the target keeps that CLI and effort.
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
      expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(9);

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
});
