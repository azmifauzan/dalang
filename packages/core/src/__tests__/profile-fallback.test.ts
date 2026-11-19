import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/client.js';
import { ProfileService } from '../services/profiles.js';

describe('per-profile fallback', () => {
  it('uses the profile fallback unless the routing rule names one, and blocks deleting a fallback in use', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-fb-'));
    const conn = openDatabase(path.join(dir, 'dalang.db'));
    const svc = new ProfileService(conn.db);
    const heavy = svc.getProfile('profile-coder-heavy');

    // Seeded rule for engineer/high names profile-lead as fallback, so the rule wins.
    const withRule = svc.resolveProfileForTask({ role: 'engineer', complexity: 'high', profileOverride: null });
    expect(withRule.primary.id).toBe(heavy.id);
    expect(withRule.fallback?.id).toBe('profile-lead');

    // With no rule fallback, the primary profile's own fallback applies.
    const rule = svc.listRoutingRules().find((r) => r.role === 'engineer' && r.complexity === 'high')!;
    svc.updateRoutingRule(rule.id, { fallbackProfileId: null });
    svc.updateProfile(heavy.id, { fallbackProfileId: 'profile-reviewer' });
    const own = svc.resolveProfileForTask({ role: 'engineer', complexity: 'high', profileOverride: null });
    expect(own.fallback?.id).toBe('profile-reviewer');

    // A profile that is another profile's fallback cannot be deleted.
    const spare = svc.createProfile({
      name: 'spare',
      provider: 'codex',
      model: '',
      effort: 'low',
      rolePrompt: '',
      permissionMode: 'workspace-write',
      timeoutMs: 600_000,
      idleTimeoutMs: 120_000,
      maxParallel: 1,
      maxReviewRounds: 2,
      fallbackProfileId: null,
    });
    svc.updateProfile(heavy.id, { fallbackProfileId: spare.id });
    expect(() => svc.deleteProfile(spare.id)).toThrow(/fallback of/);
    conn.close();
  });
});
