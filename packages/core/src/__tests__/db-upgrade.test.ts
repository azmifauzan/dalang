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
    expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(8);
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
});
