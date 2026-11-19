import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { ProviderRegistry } from '../adapters/registry.js';
import { wrapWithBwrap } from '../adapters/sandbox.js';
import { providerEvents } from '../db/schema.js';
import { assertWorktreeSafe } from '../services/git.js';
import { ProfileService } from '../services/profiles.js';
import { computeTaskWaves, globsOverlap } from '../services/scheduler.js';
import { StatisticsService } from '../services/stats.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  makeTempDir,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

function completeTaskInWorktree(cwd: string, extId: string, relFile: string, opts: RunCommandOptions): RunCommandResult {
  const resultFile = path.join(cwd, '.dalang', 'tasks', extId, 'result.json');
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  const absFile = path.join(cwd, relFile);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, `export const task = '${extId}';\n`);
  fs.writeFileSync(
    resultFile,
    JSON.stringify({
      task_id: extId,
      status: 'completed',
      changed_files: [relFile],
      summary: `Completed ${extId}`,
      notes: [],
      blockers: [],
      verify_command: 'pnpm test',
      verify_exit_code: 0,
    }),
  );
  const line = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: `Done ${extId}` },
  });
  opts.onStdoutLine?.(line);
  return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
}

describe('Phase 0.4 scheduler helpers & safety', () => {
  it('expires an exhausted usage reading after its reset time or when old with no reset time', () => {
    const reg = new ProviderRegistry();
    const win = (resetsAt: string | null) => ({
      available: true,
      windows: [{ group: 'g', window: '5h', label: '5h', usedPercent: 100, remainingPercent: 0, resetsAt }],
    });
    expect(reg.isUsageExhausted(win(new Date(Date.now() + 3_600_000).toISOString()), null, 3_600_000)).toBeTruthy();
    expect(reg.isUsageExhausted(win(new Date(Date.now() - 1000).toISOString()), null, 0)).toBeNull();
    expect(reg.isUsageExhausted(win(null), null, 60_000)).toBeTruthy();
    expect(reg.isUsageExhausted(win(null), null, 16 * 60_000)).toBeNull();
  });

  it('detects glob overlap accurately across disjoint, nested, brace, and catch-all patterns', () => {
    expect(globsOverlap(['src/a/**'], ['src/b/**'])).toBe(false);
    expect(globsOverlap(['src/**'], ['src/routes.ts'])).toBe(true);
    expect(globsOverlap(['src/*.ts'], ['src/sub/file.ts'])).toBe(false);
    expect(globsOverlap(['src/{a,b}/*.ts'], ['src/b/index.ts'])).toBe(true);
    expect(globsOverlap([], ['src/a.ts'])).toBe(true);
  });

  it('computes topological execution waves from task dependency edges', () => {
    const waves = computeTaskWaves([
      { externalId: 'T-001', dependsOn: [] },
      { externalId: 'T-002', dependsOn: ['T-001'] },
      { externalId: 'T-003', dependsOn: ['T-001'] },
      { externalId: 'T-004', dependsOn: ['T-002', 'T-003'] },
    ]);
    expect(waves.get('T-001')).toBe(0);
    expect(waves.get('T-002')).toBe(1);
    expect(waves.get('T-003')).toBe(1);
    expect(waves.get('T-004')).toBe(2);
  });

  it('mounts worktree .git link file read-only in bwrap and rejects tampered worktree .git metadata', async () => {
    const mainDir = makeTempDir('dalang-main-');
    const worktreeDir = makeTempDir('dalang-wt-');
    const { simpleGit } = await import('simple-git');
    const git = simpleGit({ baseDir: mainDir });
    await git.init();
    fs.writeFileSync(path.join(mainDir, 'README.md'), '# test\n');
    await git.add('README.md');
    await git.raw(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init']);

    fs.mkdirSync(path.join(mainDir, '.git', 'worktrees', 'wt1'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, '.git'),
      `gitdir: ${path.join(mainDir, '.git', 'worktrees', 'wt1')}\n`,
    );

    const fakeRunner: CliRunner = {
      async which(bin) {
        return bin === 'bwrap' ? '/usr/bin/bwrap' : null;
      },
      async run() {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };
    const inv = await wrapWithBwrap(fakeRunner, 'codex', worktreeDir, 'codex', ['exec'], {
      readOnly: false,
      bindProviderDirs: false,
    });
    if (process.platform === 'linux') {
      expect(inv.sandboxed).toBe(true);
      const roIdx = inv.args.indexOf('--ro-bind');
      expect(roIdx).toBeGreaterThanOrEqual(0);
      const wtDotGit = path.join(worktreeDir, '.git');
      expect(inv.args.join(' ')).toContain(`--ro-bind ${wtDotGit} ${wtDotGit}`);
    }

    const outsideDir = makeTempDir('dalang-outside-');
    fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${outsideDir}\n`);
    await expect(assertWorktreeSafe(mainDir, worktreeDir)).rejects.toThrow(/points outside/i);
  });

  it('parses Claude rate_limit_event stream messages into AdapterTurnResult.rateLimitReason', async () => {
    const logDir = makeTempDir('dalang-claude-log-');
    const runner: CliRunner = {
      async which(bin) {
        return bin === 'claude' ? '/usr/bin/claude' : null;
      },
      async run(_cmd, _args, opts) {
        const rateEv = JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 },
        });
        opts.onStdoutLine?.(rateEv);
        return { exitCode: 1, stdout: `${rateEv}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const adapter = new ClaudeCodeAdapter(runner);
    const res = await adapter.runTurn({
      projectPath: logDir,
      prompt: 'test',
      permissionMode: 'read-only',
      logFilePath: path.join(logDir, 'turn.log'),
    });
    expect(res.rateLimitReason).toContain('rate_limit_event');
    expect(res.rateLimitReason).toContain('five_hour');
  });
});

describe('Phase 0.4 parallel execution, worktrees, provider pool, quota fallback, and statistics', () => {
  it('runs non-overlapping tasks concurrently in isolated git worktrees while keeping main repo clean until Gate 2 merge', async () => {
    const activeCoders = new Set<string>();
    const observedCwds = new Map<string, string>();
    let releaseBoth!: () => void;
    let bothEntered = false;
    const bothEnteredPromise = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const leadRes = handleLeadCalls(opts.cwd, args, opts);
        if (leadRes) return leadRes;
        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const promptArg = args.find((a) => a.includes('.dalang/tasks/')) ?? args.join(' ');
        const match = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        if (match) {
          const extId = match[1];
          observedCwds.set(extId, opts.cwd);
          activeCoders.add(extId);
          if (activeCoders.size === 2 && !bothEntered) {
            bothEntered = true;
            releaseBoth();
          }
          await bothEnteredPromise;
          activeCoders.delete(extId);
          return completeTaskInWorktree(opts.cwd, extId, `src/${extId.toLowerCase()}/index.ts`, opts);
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, execSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Alpha module', complexity: 'low', depends_on: [], files_allowed: ['src/t-001/**'] },
      { id: 'T-002', title: 'Beta module', complexity: 'low', depends_on: [], files_allowed: ['src/t-002/**'] },
    ]);

    try {
      const started = await execSvc.startExecution(project.id, { allowUnconfined: true });
      expect(started.started).toBe(true);
      await execSvc.waitForProjectExecution(project.id);

      expect(bothEntered).toBe(true);
      const cwd1 = observedCwds.get('T-001')!;
      const cwd2 = observedCwds.get('T-002')!;
      expect(cwd1).not.toBe(projDir);
      expect(cwd2).not.toBe(projDir);
      expect(cwd1).not.toBe(cwd2);
      expect(cwd1).toContain(`${path.sep}worktrees${path.sep}`);
      expect(cwd2).toContain(`${path.sep}worktrees${path.sep}`);
      expect(fs.existsSync(path.join(projDir, 'src', 't-001', 'index.ts'))).toBe(false);
      expect(fs.existsSync(path.join(projDir, 'src', 't-002', 'index.ts'))).toBe(false);

      const state = await execSvc.getExecutionState(project.id);
      expect(state.dispatchPreviews.map((p) => p.status)).toEqual(['awaiting_merge', 'awaiting_merge']);

      await execSvc.approveMergeTask(project.id, state.dispatchPreviews[0].taskId, { runIntegration: false });
      await execSvc.approveMergeTask(project.id, state.dispatchPreviews[1].taskId, { runIntegration: false });
      expect(fs.existsSync(path.join(projDir, 'src', 't-001', 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(projDir, 'src', 't-002', 'index.ts'))).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('serializes tasks with overlapping files_allowed so they cannot run concurrently', async () => {
    const activeCoders = new Set<string>();
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (activeCoders.size === 1) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const leadRes = handleLeadCalls(opts.cwd, args, opts);
        if (leadRes) return leadRes;
        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const promptArg = args.find((a) => a.includes('.dalang/tasks/')) ?? args.join(' ');
        const match = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        if (match) {
          const extId = match[1];
          activeCoders.add(extId);
          expect(activeCoders.size).toBe(1);
          if (extId === 'T-001') await gate;
          activeCoders.delete(extId);
          return completeTaskInWorktree(opts.cwd, extId, `src/${extId.toLowerCase()}.ts`, opts);
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, execSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Shared file A', complexity: 'low', depends_on: [], files_allowed: ['src/**'] },
      { id: 'T-002', title: 'Shared file B', complexity: 'low', depends_on: [], files_allowed: ['src/routes.ts'] },
    ]);

    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await firstEntered;

      const midState = await execSvc.getExecutionState(project.id);
      const second = midState.dispatchPreviews.find((p) => p.externalId === 'T-002')!;
      expect(second.blockedByOverlapWith).toBe('T-001');
      expect(second.eligible).toBe(false);
      expect(midState.activeRuns).toHaveLength(1);

      releaseFirst();
      await execSvc.waitForProjectExecution(project.id);

      const postState = await execSvc.getExecutionState(project.id);
      expect(postState.dispatchPreviews.find((p) => p.externalId === 'T-001')?.status).toBe('awaiting_merge');
      expect(postState.dispatchPreviews.find((p) => p.externalId === 'T-002')?.status).toBe('approved');
    } finally {
      conn.close();
    }
  });

  it('enforces per-provider maxParallel concurrency pool across simultaneous tasks', async () => {
    let activeCodex = 0;
    let peakCodex = 0;
    const seenTasks: string[] = [];
    let releaseFirstTwo!: () => void;
    const firstTwoGate = new Promise<void>((resolve) => {
      releaseFirstTwo = resolve;
    });
    let bothSlotsFilled!: () => void;
    const bothSlotsFilledPromise = new Promise<void>((resolve) => {
      bothSlotsFilled = resolve;
    });

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const leadRes = handleLeadCalls(opts.cwd, args, opts);
        if (leadRes) return leadRes;
        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const promptArg = args.find((a) => a.includes('.dalang/tasks/')) ?? args.join(' ');
        const match = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        if (match) {
          const extId = match[1];
          activeCodex += 1;
          peakCodex = Math.max(peakCodex, activeCodex);
          seenTasks.push(extId);
          if (seenTasks.length <= 2) {
            if (activeCodex === 2) {
              bothSlotsFilled();
            }
            await firstTwoGate;
          }
          activeCodex -= 1;
          return completeTaskInWorktree(opts.cwd, extId, `src/${extId.toLowerCase()}/mod.ts`, opts);
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, execSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Part 1', complexity: 'low', depends_on: [], files_allowed: ['src/t-001/**'] },
      { id: 'T-002', title: 'Part 2', complexity: 'low', depends_on: [], files_allowed: ['src/t-002/**'] },
      { id: 'T-003', title: 'Part 3', complexity: 'low', depends_on: [], files_allowed: ['src/t-003/**'] },
    ]);

    try {
      const profileSvc = new ProfileService(conn.db);
      const codexProf = profileSvc.listProfiles().find((p) => p.provider === 'codex')!;
      profileSvc.updateProfile(codexProf.id, { maxParallel: 2 });

      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await bothSlotsFilledPromise;
      // Hold first two slots open briefly to prove 3rd task waits in pool instead of exceeding limit.
      await new Promise((r) => setTimeout(r, 120));
      expect(peakCodex).toBe(2);
      expect(seenTasks).toHaveLength(2);

      releaseFirstTwo();
      await execSvc.waitForProjectExecution(project.id);

      expect(seenTasks.sort()).toEqual(['T-001', 'T-002', 'T-003']);
      expect(peakCodex).toBe(2);
    } finally {
      conn.close();
    }
  }, 15_000);

  it('reroutes proactively on exhausted quota and reactive rate limits, and waits cleanly for busy fallback slots', async () => {
    const providerLog: Array<{ extId: string; cmd: string }> = [];
    let releaseBusyPrimary!: () => void;
    const busyPrimaryGate = new Promise<void>((r) => {
      releaseBusyPrimary = r;
    });
    let claudeBusyStarted!: () => void;
    const claudeBusyPromise = new Promise<void>((r) => {
      claudeBusyStarted = r;
    });

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const leadRes = handleLeadCalls(opts.cwd, args, opts);
        if (leadRes) return leadRes;
        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const joined = `${cmd} ${args.join(' ')}`;
        const promptArg = args.find((a) => a.includes('.dalang/tasks/')) ?? args.join(' ');
        const match = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        if (!match) {
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        const extId = match[1];
        const invokedProvider = joined.includes('codex')
          ? 'codex'
          : joined.includes('agy')
            ? 'antigravity'
            : 'claude';
        providerLog.push({ extId, cmd: invokedProvider });

        if (extId === 'T-001') {
          claudeBusyStarted();
          await busyPrimaryGate;
          return completeTaskInWorktree(opts.cwd, extId, 'src/t-001/index.ts', opts);
        }

        if (invokedProvider === 'codex' && extId === 'T-002') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: 429 Too Many Requests - quota exceeded',
            timedOut: false,
            idleTimedOut: false,
          };
        }

        return completeTaskInWorktree(opts.cwd, extId, `src/${extId.toLowerCase()}/index.ts`, opts);
      },
    };

    const { conn, registry, project, plan, execSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Heavy task on Claude', complexity: 'high', depends_on: [], files_allowed: ['src/t-001/**'] },
      { id: 'T-002', title: 'Small task hitting 429 on Codex', complexity: 'low', depends_on: [], files_allowed: ['src/t-002/**'] },
      { id: 'T-003', title: 'Third task after cooldown', complexity: 'low', depends_on: ['T-002'], files_allowed: ['src/t-003/**'] },
    ]);

    try {
      const profileSvc = new ProfileService(conn.db);
      const claudeProf = profileSvc.listProfiles().find((p) => p.name === 'coder-heavy')!;
      profileSvc.updateProfile(claudeProf.id, { maxParallel: 1 });

      // Start T-001 + T-002 concurrently: T-001 occupies claude-code (maxParallel=1), T-002 hits 429 on codex
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await claudeBusyPromise;
      await new Promise((r) => setTimeout(r, 80));

      // T-002 failed on codex and is waiting for claude-code's slot while T-001 finishes
      releaseBusyPrimary();
      await execSvc.waitForProjectExecution(project.id);

      const execState = await execSvc.getExecutionState(project.id);
      const t2Runs = execState.runs.filter((r) => r.taskExternalId === 'T-002' && r.kind === 'execute');
      expect(t2Runs).toHaveLength(2);
      const t2FallbackRun = t2Runs.find((r) => r.usedFallback);
      expect(t2FallbackRun).toBeDefined();
      expect(t2FallbackRun?.provider).toBe('claude-code');
      expect(t2FallbackRun?.status).toBe('completed');

      // Cooldown prevents codex from even being attempted on a fresh pre-exhausted snapshot / cooldown preview
      const preT3 = execState.dispatchPreviews.find((p) => p.externalId === 'T-003')!;
      expect(preT3.resolvedProvider).toBe('claude-code');
      expect(preT3.quotaReroutedReason).toMatch(/rate limit|quota|cooldown/i);

      // Clear cooldown and test proactive exhausted-usage snapshot routing directly
      registry.clearCooldown('codex');
      registry.setUsageSnapshot('codex', {
        available: true,
        windows: [{ group: 'primary', window: '5h', label: 'Primary 5h', usedPercent: 100, remainingPercent: 0, resetsAt: null }],
      });

      const t1 = plan.tasks.find((t) => t.externalId === 'T-001')!;
      const t2 = plan.tasks.find((t) => t.externalId === 'T-002')!;
      await execSvc.approveMergeTask(project.id, t1.id, { runIntegration: false });
      await execSvc.approveMergeTask(project.id, t2.id, { runIntegration: false });

      const prevCount = providerLog.length;
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      const newCalls = providerLog.slice(prevCount).filter((entry) => entry.extId === 'T-003');
      expect(newCalls).toEqual([{ extId: 'T-003', cmd: 'claude' }]);

      const afterState = await execSvc.getExecutionState(project.id);
      const t3Run = afterState.runs.find((r) => r.taskExternalId === 'T-003' && r.kind === 'execute');
      expect(t3Run?.provider).toBe('claude-code');
      expect(t3Run?.usedFallback).toBe(true);

      const stats = new StatisticsService(conn.db, () => execSvc.getProviderRuntimeStates()).getUsageStatistics();
      expect(stats.totals.fallbackRuns).toBeGreaterThanOrEqual(2);
      expect(stats.totals.rateLimitEvents).toBeGreaterThanOrEqual(1);
      const codexStats = stats.providers.find((p) => p.provider === 'codex')!;
      expect(codexStats.rateLimitEvents).toBeGreaterThanOrEqual(1);
      expect(codexStats.quotaFallbackEvents).toBeGreaterThanOrEqual(2);
      expect(stats.projects.length).toBe(1);

      const evRows = conn.db.select().from(providerEvents).all();
      expect(evRows.some((e) => e.type === 'rate_limit')).toBe(true);
      expect(evRows.some((e) => e.type === 'quota_fallback')).toBe(true);
    } finally {
      conn.close();
    }
  }, 15_000);
});

describe('Claude model discovery', () => {
  it('lists structured model objects from the initialize control response, grouping [1m] variants without "default"', async () => {
    const models = [
      { value: 'default', resolvedModel: 'claude-opus-9', displayName: 'Default' },
      {
        value: 'opus',
        resolvedModel: 'claude-opus-9',
        displayName: 'Opus',
        description: 'Opus 9 · Best',
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsFastMode: true,
        supportsAdaptiveThinking: true,
      },
      {
        value: 'claude-big-9[1m]',
        resolvedModel: 'claude-big-9',
        displayName: 'Big',
        description: 'Big 9 · 1M context',
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-9', displayName: 'Sonnet' },
    ];
    let sent = '';
    const runner: CliRunner = {
      async which(b) {
        return `/usr/bin/${b}`;
      },
      async run(_cmd, args, opts): Promise<RunCommandResult> {
        const base = { exitCode: 0, stderr: '', timedOut: false, idleTimedOut: false };
        if (args[0] === '--version') return { ...base, stdout: '1.0.0' };
        if (args[0] === 'auth') return { ...base, stdout: JSON.stringify({ loggedIn: true }) };
        if (args.includes('--input-format')) {
          sent = opts.stdinData ?? '';
          const reply = { type: 'control_response', response: { subtype: 'success', request_id: 'dalang-init', response: { models } } };
          return { ...base, stdout: `${JSON.stringify(reply)}\n` };
        }
        return { ...base, exitCode: 1, stdout: '' };
      },
    };
    const status = await new ClaudeCodeAdapter(runner).checkStatus();
    expect(JSON.parse(sent).request.subtype).toBe('initialize');
    expect(status.models.map((m) => m.id)).toEqual(['claude-opus-9', 'claude-big-9', 'claude-sonnet-9']);
    expect(status.models[0]).toMatchObject({
      value: 'opus',
      displayName: 'Opus',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true,
      supportsThinking: true,
    });
    expect(status.models[1].variants).toEqual([
      { id: '1m', label: '1M context', value: 'claude-big-9[1m]' },
    ]);
  });
});
