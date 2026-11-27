import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/client.js';
import { ProfileService, withFallbackTarget } from '../services/profiles.js';

describe('fallback target (CLI, model, effort)', () => {
  it('runs the primary profile on the fallback CLI and keeps its role instructions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-fb-'));
    const conn = openDatabase(path.join(dir, 'dalang.db'));
    try {
      const svc = new ProfileService(conn.db);
      const heavy = svc.getProfile('profile-coder-heavy');

      // The seeded engineer/high rule names a fallback target, so the rule wins.
      const withRule = svc.resolveProfileForTask({ role: 'engineer', complexity: 'high', profileOverride: null });
      expect(withRule.primary.id).toBe(heavy.id);
      expect(withRule.fallback?.rolePrompt).toBe(heavy.rolePrompt);

      // A rule target on another CLI changes provider, model, and effort but not the profile.
      const rule = svc.listRoutingRules().find((r) => r.role === 'engineer' && r.complexity === 'high')!;
      svc.updateRoutingRule(rule.id, {
        fallback: { provider: 'codex', model: 'gpt-x', effort: 'low', configDir: null },
      });
      const viaRule = svc.resolveProfileForTask({ role: 'engineer', complexity: 'high', profileOverride: null });
      expect(viaRule.fallback).toMatchObject({
        id: heavy.id,
        name: 'executor-heavy',
        provider: 'codex',
        model: 'gpt-x',
        effort: 'low',
        rolePrompt: heavy.rolePrompt,
      });

      // With no rule target, the profile's own fallback applies.
      svc.updateRoutingRule(rule.id, { fallback: null });
      svc.updateProfile(heavy.id, {
        fallback: { provider: 'antigravity', model: '', effort: 'medium', configDir: null },
      });
      const own = svc.resolveProfileForTask({ role: 'engineer', complexity: 'high', profileOverride: null });
      expect(own.fallback?.provider).toBe('antigravity');
      expect(own.fallback?.name).toBe('executor-heavy');
    } finally {
      conn.close();
    }
  });

  it('drops a fallback that would run the same thing, and keeps a second account of the same CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-fb2-'));
    const conn = openDatabase(path.join(dir, 'dalang.db'));
    try {
      const svc = new ProfileService(conn.db);
      const heavy = svc.getProfile('profile-coder-heavy');
      expect(
        withFallbackTarget(heavy, { provider: heavy.provider, model: heavy.model, effort: heavy.effort, configDir: null }),
      ).toBeNull();
      const otherAccount = withFallbackTarget(heavy, {
        provider: heavy.provider,
        model: heavy.model,
        effort: heavy.effort,
        configDir: path.join(dir, 'acct2'),
      });
      expect(otherAccount?.configDir).toBe(path.join(dir, 'acct2'));
      // Another CLI never inherits the primary's account directory.
      const otherCli = withFallbackTarget(
        { ...heavy, configDir: path.join(dir, 'acct1') },
        { provider: 'codex', model: '', effort: 'low', configDir: null },
      );
      expect(otherCli?.configDir).toBeNull();
    } finally {
      conn.close();
    }
  });
});
