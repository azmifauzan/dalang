import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProfileByRef } from '@dalang/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/client.js';
import { ProfileService } from '../services/profiles.js';
import { resolveMentionTarget } from '../services/room-routing.js';

const OLD = [
  ['profile-coder-small', 'coder-small'],
  ['profile-coder-medium', 'coder-medium'],
  ['profile-coder-heavy', 'coder-heavy'],
  ['profile-qa', 'qa'],
];

/** A database as v17 left it: the seeded profiles under their old names. */
function v17Database(extraSql = ''): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-up18-')), 'dalang.db');
  const conn = openDatabase(file);
  for (const [id, name] of OLD) conn.sqlite.prepare('UPDATE agent_profiles SET name = ? WHERE id = ?').run(name, id);
  conn.sqlite.exec(extraSql);
  conn.sqlite.pragma('user_version = 17');
  conn.close();
  return file;
}

function namesById(file: string): Record<string, string> {
  const conn = openDatabase(file);
  expect(conn.sqlite.pragma('user_version', { simple: true })).toBe(19);
  const names = Object.fromEntries(new ProfileService(conn.db).listProfiles().map((p) => [p.id, p.name]));
  conn.close();
  return names;
}

describe('seeded profile names (U6, schema v18)', () => {
  it('renames the seeded profiles on upgrade and keeps their ids', () => {
    const file = v17Database();
    const names = namesById(file);
    expect(OLD.map(([id]) => names[id])).toEqual(['executor-light', 'executor-medium', 'executor-heavy', 'checker']);
    expect(Object.keys(names)).toHaveLength(6);
  });

  it('keeps a name the user chose, and does not take a name already in use', () => {
    const file = v17Database(`
      UPDATE agent_profiles SET name = 'my-fast-one' WHERE id = 'profile-coder-small';
      UPDATE agent_profiles SET name = 'Checker' WHERE id = 'profile-reviewer';
    `);
    const names = namesById(file);
    expect(names['profile-coder-small']).toBe('my-fast-one');
    expect(names['profile-qa']).toBe('qa');
    expect(names['profile-coder-heavy']).toBe('executor-heavy');
  });

  it('resolves an old name to the same profile, unless a profile really has that name', () => {
    const conn = openDatabase(':memory:');
    const profiles = new ProfileService(conn.db).listProfiles();
    conn.close();
    expect(findProfileByRef(profiles, 'coder-medium')?.name).toBe('executor-medium');
    expect(findProfileByRef(profiles, 'qa')?.name).toBe('checker');
    expect(findProfileByRef(profiles, 'toString')).toBeUndefined();
    const own = { ...profiles[0], id: 'mine', name: 'qa' };
    expect(findProfileByRef([...profiles, own], 'qa')?.id).toBe('mine');

    for (const mention of ['@coder-heavy look', '@executor-heavy look']) {
      expect(resolveMentionTarget(mention, profiles, [])).toMatchObject({ route: 'ask', profile: { id: 'profile-coder-heavy' } });
    }
    for (const mention of ['@qa look', '@checker look']) {
      expect(resolveMentionTarget(mention, profiles, [])).toMatchObject({ route: 'ask', profile: { id: 'profile-qa' } });
    }
    expect(resolveMentionTarget('@executor look', profiles, [])).toMatchObject({ profile: { id: 'profile-coder-small' } });
    const run = { profileId: 'profile-coder-medium', profileName: 'executor-medium', kind: 'execute' as const };
    expect(resolveMentionTarget('@coder-medium stop', profiles, [run as never])).toMatchObject({ route: 'steer', run });
  });
});
