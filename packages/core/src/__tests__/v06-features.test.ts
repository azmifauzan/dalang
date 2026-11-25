import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLanguageInstruction,
  buildReviewPrompt,
  compareSemver,
  LeadService,
  openDatabase,
  ProfileService,
  ProjectService,
  ProviderRegistry,
  SettingsService,
  UpdateCheckService,
  type CliRunner,
} from '../index.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('v0.6 backend: settings, language prompts, and update check', () => {
  it('persists language and checkForUpdates in SettingsService', () => {
    const dbDir = makeTempDir('dalang-v06-set-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    try {
      const settings = new SettingsService(conn.db);
      expect(settings.getAll()).toEqual({
        antigravityKeyringAccess: false,
        language: null,
        checkForUpdates: true,
        usageRefreshMinutes: 5,
      });
      expect(settings.resolvedLanguage()).toBe('en');

      const updated = settings.update({ language: 'id', checkForUpdates: false });
      expect(updated).toEqual({
        antigravityKeyringAccess: false,
        language: 'id',
        checkForUpdates: false,
        usageRefreshMinutes: 5,
      });
      expect(settings.resolvedLanguage()).toBe('id');

      // The limits bar interval: 5 minutes by default, and a stored value that is not 3, 5, or 10 falls back.
      expect(settings.update({ usageRefreshMinutes: 10 }).usageRefreshMinutes).toBe(10);
    } finally {
      conn.close();
    }
  });

  it('checks npm updates with 24h caching, toggle-off suppression, and silent offline fallback', async () => {
    const dbDir = makeTempDir('dalang-v06-upd-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    try {
      const settings = new SettingsService(conn.db);
      let clock = Date.parse('2026-11-19T10:00:00Z');
      let fetchCalls = 0;

      const checker = new UpdateCheckService(settings, {
        currentVersion: '0.6.0',
        now: () => clock,
        fetcher: async () => {
          fetchCalls += 1;
          return '0.7.0';
        },
      });

      const first = await checker.getStatus();
      expect(first.updateAvailable).toBe(true);
      expect(first.latestVersion).toBe('0.7.0');
      expect(first.checkEnabled).toBe(true);
      expect(fetchCalls).toBe(1);

      // Within 24h -> served from cache without another network call.
      clock += 6 * 60 * 60 * 1000;
      const cached = await checker.getStatus();
      expect(cached.updateAvailable).toBe(true);
      expect(fetchCalls).toBe(1);

      // After 24h -> refetches.
      clock += 20 * 60 * 60 * 1000;
      const refreshed = await checker.getStatus();
      expect(refreshed.latestVersion).toBe('0.7.0');
      expect(fetchCalls).toBe(2);

      // Toggle off -> never fetches and hides notice.
      settings.update({ checkForUpdates: false });
      const disabled = await checker.getStatus({ force: true });
      expect(disabled.checkEnabled).toBe(false);
      expect(disabled.updateAvailable).toBe(false);
      expect(disabled.latestVersion).toBeNull();
      expect(fetchCalls).toBe(2);

      // Offline / network failure -> fails silently.
      settings.update({ checkForUpdates: true });
      let offlineCalls = 0;
      const offlineChecker = new UpdateCheckService(settings, {
        currentVersion: '0.6.0',
        now: () => clock,
        fetcher: async () => {
          offlineCalls += 1;
          throw new Error('network down');
        },
      });
      const offline = await offlineChecker.getStatus({ force: true });
      // A failed check keeps the last answer the registry gave.
      expect(offline.latestVersion).toBe('0.7.0');
      expect(offlineCalls).toBe(1);
      // A failed attempt is throttled too: no retry inside the 24h window.
      await offlineChecker.getStatus();
      await offlineChecker.getStatus();
      expect(offlineCalls).toBe(1);

      // No earlier answer and no network: nothing to show.
      const fresh = openDatabase(path.join(dbDir, 'fresh.db'));
      try {
        const none = await new UpdateCheckService(new SettingsService(fresh.db), {
          currentVersion: '0.6.0',
          fetcher: async () => null,
        }).getStatus();
        expect(none.latestVersion).toBeNull();
        expect(none.updateAvailable).toBe(false);
      } finally {
        fresh.close();
      }
    } finally {
      conn.close();
    }
  });

  it('compares semver versions cleanly', () => {
    expect(compareSemver('0.7.0', '0.6.0')).toBeGreaterThan(0);
    expect(compareSemver('0.6.1', '0.6.0')).toBeGreaterThan(0);
    expect(compareSemver('0.6.0', '0.6.0')).toBe(0);
    expect(compareSemver('0.5.9', '0.6.0')).toBeLessThan(0);
    expect(compareSemver('0.6.0', '0.6.0-rc.1')).toBeGreaterThan(0);
  });

  it('injects Indonesian and English language instructions into Lead and Reviewer prompts', async () => {
    const dbDir = makeTempDir('dalang-v06-lang-db-');
    const projDir = path.join(makeTempDir('dalang-v06-lang-proj-'), 'app');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));

    const capturedPrompts: string[] = [];
    const fakeRunner: CliRunner = {
      async which(bin) {
        return bin === 'claude' ? '/usr/bin/claude' : null;
      },
      async run(command, args, opts) {
        const promptArg = args.find((a) => a.includes('Language:')) ?? '';
        capturedPrompts.push(promptArg);
        const roundMatch = promptArg.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?discuss\/round-1\.json)/);
        const briefMatch = promptArg.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?brief\.v1\.json)/);
        if (roundMatch) {
          const p = path.join(opts.cwd, roundMatch[1]);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(
            p,
            JSON.stringify({
              round: 1,
              summary: 'Pertanyaan klarifikasi',
              ready_for_brief: false,
              questions: [
                {
                  id: 'q1',
                  question: 'Target pengguna utamanya siapa?',
                  reason: 'Menentukan alur autentikasi',
                  kind: 'single',
                  options: ['Tim internal', 'Publik'],
                  allow_custom: true,
                },
              ],
            }),
          );
        } else if (briefMatch) {
          const p = path.join(opts.cwd, briefMatch[1]);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(
            p,
            JSON.stringify({
              version: 1,
              title: 'Aplikasi Catatan',
              summary: 'Catatan harian sederhana',
              scope: ['CRUD catatan'],
              features: ['Tambah catatan'],
              stack: ['Node.js'],
              constraints: [],
              out_of_scope: [],
              assumptions: [],
            }),
          );
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: 'result', session_id: 's1', result: 'ok' }) + '\n',
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
          aborted: false,
        };
      },
    };

    try {
      const settings = new SettingsService(conn.db);
      settings.update({ language: 'id' });
      const registry = new ProviderRegistry(fakeRunner);
      const projectService = new ProjectService(conn.db);
      const leadService = new LeadService(conn.db, registry, undefined, () =>
        settings.resolvedLanguage(),
      );

      const proj = await projectService.createOrOpen({
        mode: 'create',
        name: 'Catatan',
        path: projDir,
        initGitIfMissing: false,
        leadProvider: 'claude-code',
      });

      await leadService.sendDiscussMessage(proj.id, { message: 'Buat aplikasi catatan lokal' });
      expect(capturedPrompts[0]).toContain('Bahasa Indonesia');

      await leadService.finishDiscussAndWriteBrief(proj.id);
      expect(capturedPrompts[1]).toContain('Bahasa Indonesia');

      expect(buildLanguageInstruction('en')).toContain('clear English');
      expect(buildLanguageInstruction('id')).toContain('Bahasa Indonesia');

      const reviewPromptId = buildReviewPrompt({
        task: {
          id: 't1',
          planId: 'p1',
          externalId: 'T-001',
          title: 'Add notes route',
          milestone: 'M1',
          role: 'engineer',
          complexity: 'low',
          output: 'files',
          status: 'reviewing',
          position: 0,
          goal: 'Add route',
          filesAllowed: ['src/**'],
          filesReference: [],
          acceptanceCriteria: ['Returns 200'],
          verify: 'pnpm test',
          needsSplit: false,
          splitDepth: 0,
          parentTaskId: null,
          delegatedByRunId: null,
          delegationDepth: 0,
          mergeTargetBranch: null,
          profileOverride: null,
          reviewRounds: 0,
          branchName: 'dalang/T-001',
          mergeCommitSha: null,
          rejectionNote: null,
          prUrl: null,
          pushedAt: null,
          dependsOn: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        profile: {
          id: 'prof-rev',
          name: 'reviewer',
          provider: 'claude-code',
          model: '',
          effort: 'high',
          rolePrompt: '',
          permissionMode: 'read-only',
          timeoutMs: 60000,
          idleTimeoutMs: 30000,
          maxParallel: 1,
          maxReviewRounds: 2,
          fallback: null,
          configDir: null,
          isDefault: true,
          createdAt: new Date().toISOString(),
        },
        relReviewPath: '.dalang/tasks/T-001/review.json',
        round: 1,
        maxRounds: 2,
        verifyExitCode: 0,
        verifyOutput: 'ok',
        changedFiles: ['src/notes.ts'],
        scopeWarnings: [],
        rawDiff: '+export const ok = true;',
        coderResult: null,
        language: 'id',
      });
      expect(reviewPromptId).toContain('Bahasa Indonesia');
    } finally {
      conn.close();
    }
  });

  it('defaults a new project Lead to the provider of the Lead routing rule', async () => {
    const dbDir = makeTempDir('dalang-v06-lead-');
    const conn = openDatabase(path.join(dbDir, 'dalang.db'));
    try {
      const projects = new ProjectService(conn.db);
      const profiles = new ProfileService(conn.db);

      const first = await projects.createOrOpen({
        mode: 'create',
        path: path.join(makeTempDir('dalang-v06-p1-'), 'one'),
        initGitIfMissing: false,
      });
      expect(first.leadProvider).toBe('claude-code'); // seeded Lead profile

      const leadRule = profiles.listRoutingRules().find((r) => r.role === 'lead')!;
      const codex = profiles.listProfiles().find((p) => p.provider === 'codex')!;
      profiles.updateRoutingRule(leadRule.id, { profileId: codex.id });

      const second = await projects.createOrOpen({
        mode: 'create',
        path: path.join(makeTempDir('dalang-v06-p2-'), 'two'),
        initGitIfMissing: false,
      });
      expect(second.leadProvider).toBe('codex');
    } finally {
      conn.close();
    }
  });

  it('upgrades untouched seeded role instructions and keeps customised ones', () => {
    const dbFile = path.join(makeTempDir('dalang-v06-roles-'), 'dalang.db');
    const first = openDatabase(dbFile);
    const prompt = (id: string) =>
      (first.sqlite.prepare('SELECT role_prompt AS p FROM agent_profiles WHERE id = ?').get(id) as { p: string }).p;
    // A fresh install gets the detailed text.
    expect(prompt('profile-coder-heavy')).toContain('senior executor');
    expect(prompt('profile-reviewer')).toContain('independent reviewer');
    // Simulate a database seeded by an earlier release, with one profile edited by the user.
    const set = first.sqlite.prepare('UPDATE agent_profiles SET role_prompt = ? WHERE id = ?');
    set.run('Focused engineer for well-scoped, low-complexity tasks.', 'profile-coder-small');
    set.run('My own reviewer rules.', 'profile-reviewer');
    first.close();

    const second = openDatabase(dbFile);
    try {
      const read = (id: string) =>
        (second.sqlite.prepare('SELECT role_prompt AS p FROM agent_profiles WHERE id = ?').get(id) as { p: string }).p;
      expect(read('profile-coder-small')).toContain('focused executor working a small');
      expect(read('profile-reviewer')).toBe('My own reviewer rules.');
    } finally {
      second.close();
    }
  });
});
