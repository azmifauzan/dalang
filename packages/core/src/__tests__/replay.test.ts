import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../adapters/registry.js';
import { openDatabase } from '../db/client.js';
import { DalangEventBus } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { listHiddenCheckpointRefs } from '../services/git.js';
import { LeadService } from '../services/lead.js';
import { ProfileService } from '../services/profiles.js';
import { ProjectService } from '../services/project.js';
import { StatisticsService } from '../services/stats.js';
import { loadReplayTranscript, ReplayCliRunner, type ReplayTranscript } from '../testing/replay-runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, 'fixtures', 'replays');

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

async function seedProjectWithTasks(
  transcript: ReplayTranscript,
  tasksSpec: Array<{
    title: string;
    complexity?: 'low' | 'medium' | 'high';
    filesAllowed: string[];
    verify: string;
    dependsOn?: string[];
  }>,
  opts: { ghPrUrl?: string } = {},
) {
  const runner = new ReplayCliRunner(transcript, {
    runRealShellCommands: true,
    ghPrUrl: opts.ghPrUrl,
  });
  const dbDir = makeTempDir('dalang-replay-db-');
  const projDir = path.join(makeTempDir('dalang-replay-proj-'), 'app');
  const conn = openDatabase(path.join(dbDir, 'dalang.db'));
  const events = new DalangEventBus();
  const registry = new ProviderRegistry(runner, { antigravityKeyringAccess: () => false });
  const projectSvc = new ProjectService(conn.db);
  const profileSvc = new ProfileService(conn.db);
  const reviewer = transcript.turns.find((turn) => turn.id?.includes('review'))?.match?.provider;
  if (reviewer) profileSvc.updateProfile('profile-reviewer', { provider: reviewer, model: '' });
  const leadSvc = new LeadService(conn.db, registry, events);
  const execSvc = new ExecutionService(conn.db, registry, leadSvc, events);
  const statsSvc = new StatisticsService(conn.db, () => execSvc.getProviderRuntimeStates());

  const project = await projectSvc.createOrOpen({
    mode: 'create',
    name: transcript.name,
    path: projDir,
    stackHint: 'Node.js ESM',
    initGitIfMissing: false,
    leadProvider: 'claude-code',
  });

  // Seed an approved brief and plan directly via LeadService using synthetic brief/plan turns.
  const briefPath = path.join(projDir, '.dalang', 'brief.v1.json');
  fs.writeFileSync(
    briefPath,
    JSON.stringify({
      version: 1,
      title: transcript.name,
      summary: transcript.description ?? 'Replay test app',
      scope: ['Core module'],
      features: ['Core feature'],
      stack: ['Node.js'],
      constraints: [],
      out_of_scope: [],
      assumptions: [],
    }),
  );

  // Use a one-shot lead runner only to populate the brief + initial plan, or insert via public APIs:
  const leadTranscript: ReplayTranscript = {
    name: 'lead-seed',
    turns: [
      {
        match: { provider: 'claude-code', promptContains: 'brief.v1.json' },
        files: {
          '.dalang/brief.v1.json': fs.readFileSync(briefPath, 'utf8'),
        },
        stdoutLines: [JSON.stringify({ type: 'result', session_id: 'lead-s1', result: 'ok' })],
        exitCode: 0,
      },
      {
        match: { provider: 'claude-code', promptContains: 'plan-v1.json' },
        files: {
          '.dalang/tmp/plan-v1.json': JSON.stringify({
            version: 1,
            brief_version: 1,
            milestones: [{ id: 'M1', title: 'Core', description: '' }],
            tasks: tasksSpec.map((t, i) => ({
              id: `T-${String(i + 1).padStart(3, '0')}`,
              title: t.title,
              milestone: 'M1',
              role: 'engineer',
              complexity: t.complexity ?? 'low',
              depends_on: t.dependsOn ?? [],
              goal: `Implement ${t.title}`,
              files_allowed: t.filesAllowed,
              files_reference: ['PROJECT.md'],
              acceptance_criteria: [`${t.title} passes verify`],
              verify: t.verify,
              needs_split: false,
            })),
          }),
        },
        stdoutLines: [JSON.stringify({ type: 'result', session_id: 'lead-s1', result: 'ok' })],
        exitCode: 0,
      },
    ],
  };
  const seedRegistry = new ProviderRegistry(new ReplayCliRunner(leadTranscript), {
    antigravityKeyringAccess: () => false,
  });
  const seedLead = new LeadService(conn.db, seedRegistry, events);
  await seedLead.finishDiscussAndWriteBrief(project.id);
  seedLead.approveBrief(project.id, 1);
  await seedLead.generatePlan(project.id);
  const plan = seedLead.approvePlan(project.id);

  return { conn, runner, registry, projectSvc, profileSvc, leadSvc, execSvc, statsSvc, project, plan, projDir };
}

describe('v0.5 Replay runner scenarios (process-only replacement)', () => {
  it('Scenario 1: quota reroute from primary Claude account to second Claude account (custom configDir) with token & cost stats', async () => {
    const transcript = loadReplayTranscript(path.join(FIXTURES_DIR, 'quota-reroute.json'));
    const acct2Dir = makeTempDir('dalang-claude-acct2-');
    const ctx = await seedProjectWithTasks(transcript, [
      {
        title: 'Add math module',
        complexity: 'high',
        filesAllowed: ['src/math.mjs', 'src/math.test.mjs'],
        verify: 'node --test src/math.test.mjs',
      },
    ]);

    try {
      // Route engineer/high to executor-heavy with a fallback to a second Claude account (its own config dir).
      const rules = ctx.profileSvc.listRoutingRules();
      const highRule = rules.find((r) => r.role === 'engineer' && r.complexity === 'high')!;
      ctx.profileSvc.updateRoutingRule(highRule.id, {
        fallback: { provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high', configDir: acct2Dir },
      });

      await ctx.execSvc.startExecution(ctx.project.id, { allowUnconfined: true });
      await ctx.execSvc.waitForProjectExecution(ctx.project.id);

      const execState = await ctx.execSvc.getExecutionState(ctx.project.id);
      const t1 = ctx.leadSvc.getPlan(ctx.project.id)!.tasks[0];
      expect(t1.status).toBe('awaiting_merge');

      // Primary account failed on rate_limit_event; second account ran with CLAUDE_CONFIG_DIR and succeeded.
      const coderRuns = execState.runs.filter((r) => r.kind === 'execute');
      expect(coderRuns).toHaveLength(2);
      const failedPrimary = coderRuns.find((r) => r.status === 'failed')!;
      const succeededBackup = coderRuns.find((r) => r.status === 'completed')!;
      expect(failedPrimary.failureReason).toMatch(/rate_limit_event/i);
      expect(failedPrimary.checkpointAfterRef).toMatch(/^refs\/dalang\/checkpoints\/failed-/);
      expect(succeededBackup.usedFallback).toBe(true);
      // The fallback keeps the primary profile (and its role instructions); only the account and model differ.
      expect(succeededBackup.profileName).toBe('executor-heavy');
      expect(succeededBackup.accountKey).toContain(acct2Dir);
      expect(succeededBackup.inputTokens).toBe(1200);
      expect(succeededBackup.outputTokens).toBe(450);
      expect(succeededBackup.cacheReadTokens).toBe(4800);
      expect(succeededBackup.estimatedCostUsd).toBeCloseTo(0.0124, 5);
      expect(succeededBackup.costSource).toBe('cli');

      // Verify CLAUDE_CONFIG_DIR was passed to the backup invocation.
      const backupInv = ctx.runner.invocations.find((i) => i.matchedTurnId === 'backup-account-coder');
      expect(backupInv?.env?.CLAUDE_CONFIG_DIR).toBe(acct2Dir);

      // Verify cooldown is scoped to the primary account only (backup account stays usable).
      const rtStates = ctx.execSvc.getProviderRuntimeStates();
      const primaryRt = rtStates.find((s) => s.accountKey === 'claude-code')!;
      const acct2Rt = rtStates.find((s) => s.accountKey === `claude-code:${acct2Dir}`)!;
      expect(primaryRt.inCooldown).toBe(true);
      expect(acct2Rt.inCooldown).toBe(false);

      // Verify statistics aggregate tokens and estimated cost per model.
      const stats = ctx.statsSvc.getUsageStatistics();
      expect(stats.totals.totalTokens).toBeGreaterThan(8000);
      expect(stats.totals.cacheHitRate).toBeGreaterThan(50);
      expect(stats.totals.estimatedCostUsd).toBeGreaterThan(0.01);
      expect(stats.models.length).toBeGreaterThanOrEqual(2);
    } finally {
      ctx.conn.close();
    }
  }, process.platform === 'win32' ? 60_000 : 20_000);

  it('Scenario 2: failed review round 1 -> coder fix round 2 -> pass -> merge -> push & open PR via gh', async () => {
    const transcript = loadReplayTranscript(path.join(FIXTURES_DIR, 'review-fix-round.json'));
    const ctx = await seedProjectWithTasks(
      transcript,
      [
        {
          title: 'Slugify helper',
          complexity: 'medium',
          filesAllowed: ['src/slug.mjs', 'src/slug.test.mjs'],
          verify: 'node --test src/slug.test.mjs',
        },
      ],
      { ghPrUrl: 'https://github.com/example/slug/pull/7' },
    );

    try {
      // Configure a local bare remote so `git push` actually runs for real!
      const bareRemote = makeTempDir('dalang-bare-remote-');
      await simpleGit(bareRemote).init(true);
      await simpleGit(ctx.projDir).addRemote('origin', bareRemote);
      ctx.projectSvc.updateSettings(ctx.project.id, {
        integrationCommand: 'node --test src/slug.test.mjs',
        gitRemote: 'origin',
        createPrAfterMerge: true,
      });

      await ctx.execSvc.startExecution(ctx.project.id, { allowUnconfined: true });
      await ctx.execSvc.waitForProjectExecution(ctx.project.id);

      const guard = await ctx.execSvc.getGuardState(ctx.project.id);
      const entry = guard.tasks[0];
      expect(entry.task.status).toBe('awaiting_merge');
      expect(entry.reviews).toHaveLength(2);
      expect(entry.reviews.find((r) => r.round === 1)?.status).toBe('fail');
      expect(entry.reviews.find((r) => r.round === 1)?.verifyExitCode).not.toBe(0);
      expect(entry.reviews.find((r) => r.round === 2)?.status).toBe('pass');
      expect(entry.reviews.find((r) => r.round === 2)?.verifyExitCode).toBe(0);

      // Approve merge -> runs integration tests + pushes branch + opens PR via gh!
      const merged = await ctx.execSvc.approveMergeTask(ctx.project.id, entry.task.id, {
        runIntegration: true,
        allowUnconfined: true,
      });
      expect(merged.task.status).toBe('done');
      expect(merged.integrationRun?.status).toBe('passed');
      expect(merged.pushPrResult).toEqual({
        pushed: true,
        remote: 'origin',
        branch: 'dalang/T-001',
        prUrl: 'https://github.com/example/slug/pull/7',
        message: expect.stringContaining('opened PR'),
      });
      expect(merged.task.prUrl).toBe('https://github.com/example/slug/pull/7');

      // Confirm the task branch actually landed in the bare remote repo.
      const remoteHeads = await simpleGit(bareRemote).raw(['branch', '-a']);
      expect(remoteHeads).toContain('dalang/T-001');

      // Confirm gh pr create received the task brief and review summary in --body.
      const ghInv = ctx.runner.invocations.find((i) => path.basename(i.innerCommand) === 'gh');
      expect(ghInv).toBeDefined();
      const bodyIdx = ghInv!.innerArgs.indexOf('--body');
      expect(bodyIdx).toBeGreaterThan(-1);
      const prBody = ghInv!.innerArgs[bodyIdx + 1];
      expect(prBody).toContain('Task T-001');
      expect(prBody).toContain('Automated Review');
      expect(prBody).toContain('PASS');
    } finally {
      ctx.conn.close();
    }
  }, process.platform === 'win32' ? 60_000 : 20_000);

  it('Scenario 4: a locked JavaScript project gets its dependencies installed in the task worktree before the coder starts', async () => {
    const transcript = loadReplayTranscript(path.join(FIXTURES_DIR, 'review-fix-round.json'));
    const ctx = await seedProjectWithTasks(transcript, [
      {
        title: 'Slugify helper',
        complexity: 'medium',
        filesAllowed: ['src/slug.mjs', 'src/slug.test.mjs'],
        verify: 'node --test src/slug.test.mjs',
      },
    ]);

    try {
      const pkg = { name: 'app', version: '1.0.0', private: true };
      fs.writeFileSync(path.join(ctx.projDir, 'package.json'), JSON.stringify(pkg));
      fs.writeFileSync(
        path.join(ctx.projDir, 'package-lock.json'),
        JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { '': pkg } }),
      );
      fs.writeFileSync(path.join(ctx.projDir, '.gitignore'), 'node_modules/\n');
      await simpleGit(ctx.projDir).add(['package.json', 'package-lock.json', '.gitignore']);
      await simpleGit(ctx.projDir).commit('add package manifest');

      await ctx.execSvc.startExecution(ctx.project.id, { allowUnconfined: true });
      await ctx.execSvc.waitForProjectExecution(ctx.project.id);

      const setupIdx = ctx.runner.invocations.findIndex((i) => i.innerArgs.join(' ').includes('npm ci --no-audit'));
      const firstCoderIdx = ctx.runner.invocations.findIndex((i) => i.matchedTurnId !== undefined);
      expect(setupIdx).toBeGreaterThanOrEqual(0);
      expect(setupIdx).toBeLessThan(firstCoderIdx);
      expect(ctx.runner.invocations[setupIdx].cwd).toContain(path.join('T-001'));
      // Once installed, later rounds in the same worktree do not install again.
      // Agent turns are left out: their prompt names what DALANG already installed.
      expect(ctx.runner.invocations.filter((i) => i.matchedTurnId === undefined && i.innerArgs.join(' ').includes('npm ci')).length).toBe(1);
      expect(ctx.runner.invocations[firstCoderIdx].innerArgs.join(' ')).toContain('DALANG already prepared this worktree with: npm ci');
      expect(ctx.leadSvc.getPlan(ctx.project.id)!.tasks[0].status).toBe('awaiting_merge');
    } finally {
      ctx.conn.close();
    }
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it('Scenario 5: a repository that ignores .dalang/ still runs, reviews, and merges a task without committing DALANG artifacts', async () => {
    const transcript = loadReplayTranscript(path.join(FIXTURES_DIR, 'review-fix-round.json'));
    const ctx = await seedProjectWithTasks(transcript, [
      {
        title: 'Slugify helper',
        complexity: 'medium',
        filesAllowed: ['src/slug.mjs', 'src/slug.test.mjs'],
        verify: 'node --test src/slug.test.mjs',
      },
    ]);

    try {
      const git = simpleGit(ctx.projDir);
      fs.writeFileSync(path.join(ctx.projDir, '.gitignore'), '.dalang/\n');
      await git.rm(['-r', '--cached', '-q', '.dalang']).catch(() => undefined);
      await git.add(['.gitignore']);
      await git.commit('ignore dalang artifacts');

      await ctx.execSvc.startExecution(ctx.project.id, { allowUnconfined: true });
      await ctx.execSvc.waitForProjectExecution(ctx.project.id);

      const guard = await ctx.execSvc.getGuardState(ctx.project.id);
      const entry = guard.tasks[0];
      expect(entry.task.status).toBe('awaiting_merge');
      expect(entry.reviews.find((r) => r.round === 2)?.status).toBe('pass');

      const merged = await ctx.execSvc.approveMergeTask(ctx.project.id, entry.task.id, { allowUnconfined: true });
      expect(merged.task.status).toBe('done');
      const tracked = (await git.raw(['ls-files'])).split('\n');
      expect(tracked).toContain('src/slug.mjs');
      expect(tracked.some((f) => f.startsWith('.dalang/'))).toBe(false);
    } finally {
      ctx.conn.close();
    }
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it('Scenario 3: two parallel tasks in isolated worktrees merge cleanly with hidden baseline checkpoints', async () => {
    const transcript = loadReplayTranscript(path.join(FIXTURES_DIR, 'parallel-merge.json'));
    const ctx = await seedProjectWithTasks(transcript, [
      {
        title: 'Alpha module',
        complexity: 'low',
        filesAllowed: ['src/alpha.mjs', 'src/alpha.test.mjs'],
        verify: 'node --test src/alpha.test.mjs',
      },
      {
        title: 'Beta module',
        complexity: 'low',
        filesAllowed: ['src/beta.mjs', 'src/beta.test.mjs'],
        verify: 'node --test src/beta.test.mjs',
      },
    ]);

    try {
      ctx.projectSvc.updateSettings(ctx.project.id, {
        integrationCommand: 'node --test src/*.test.mjs',
      });

      const started = await ctx.execSvc.startExecution(ctx.project.id, { allowUnconfined: true });
      expect(started.runs?.length).toBe(2);
      await ctx.execSvc.waitForProjectExecution(ctx.project.id);

      const planAfterRun = ctx.leadSvc.getPlan(ctx.project.id)!;
      expect(planAfterRun.tasks.every((t) => t.status === 'awaiting_merge')).toBe(true);

      // Verify hidden checkpoint refs exist under refs/dalang/checkpoints/.
      const hiddenRefs = await listHiddenCheckpointRefs(ctx.projDir);
      expect(hiddenRefs.length).toBeGreaterThanOrEqual(2);

      // Merge both tasks cleanly onto main.
      for (const t of planAfterRun.tasks) {
        const res = await ctx.execSvc.approveMergeTask(ctx.project.id, t.id, { runIntegration: true, allowUnconfined: true });
        expect(res.task.status).toBe('done');
        expect(res.integrationRun?.status).toBe('passed');
      }

      expect(fs.existsSync(path.join(ctx.projDir, 'src/alpha.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(ctx.projDir, 'src/beta.mjs'))).toBe(true);

      // Token stats should cover Lead brief/plan turns, Codex coder turns, and Claude reviewer turns.
      const stats = ctx.statsSvc.getUsageStatistics({ projectId: ctx.project.id });
      expect(stats.totals.totalRuns).toBe(6);
      expect(stats.totals.inputTokens).toBeGreaterThan(0);
      expect(stats.totals.cacheReadTokens).toBeGreaterThan(0);
      expect(stats.totals.estimatedCostUsd).toBeGreaterThan(0);
    } finally {
      ctx.conn.close();
    }
  }, process.platform === 'win32' ? 60_000 : 20_000);
});
