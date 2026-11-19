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
    expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(7);
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
});
