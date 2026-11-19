import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/client.js';

describe('database upgrade', () => {
  it('opens a v3 database that lacks the v4 to v6 columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up-'));
    const file = path.join(dir, 'dalang.db');
    const fresh = openDatabase(file);
    const drop: Array<[string, string]> = [
      ['agent_profiles', 'max_review_rounds'],
      ['projects', 'integration_command'],
      ['tasks', 'branch_name'],
      ['tasks', 'merge_commit_sha'],
      ['tasks', 'rejection_note'],
      ['runs', 'kind'],
      ['runs', 'branch_name'],
      ['runs', 'worktree_path'],
      ['agent_profiles', 'fallback_profile_id'],
    ];
    for (const [t, c] of drop) fresh.sqlite.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    fresh.sqlite.exec(`DELETE FROM routing_rules WHERE role = 'reviewer'`);
    fresh.sqlite.pragma('user_version = 3');
    fresh.close();

    const upgraded = openDatabase(file);
    expect(upgraded.sqlite.pragma('user_version', { simple: true })).toBe(6);
    const cols = (upgraded.sqlite.pragma('table_info(runs)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('worktree_path');
    expect(upgraded.sqlite.prepare(`SELECT count(*) n FROM routing_rules WHERE role = 'reviewer'`).get()).toEqual({ n: 1 });
    upgraded.close();
  });
});
