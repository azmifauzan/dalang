import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { ProviderRegistry } from '../adapters/registry.js';
import { ProfileService } from '../services/profiles.js';
import { SettingsService } from '../services/settings.js';
import {
  canRunRealBwrap,
  cleanupTempDirs,
  shellCommand,
  handleLeadCalls,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('v0.3 Kawal: Reviewer, Fix Loop, Guard Diff/Merge, Integration, Profiles & Routing', () => {
  it('runs verify + reviewer -> fix loop -> pass within 2 rounds, then approves merge + integration tests', async () => {
    let bugFixed = false;
    let fixPromptSeen = '';
    const reviewerProviders: string[] = [];

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts: RunCommandOptions): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        if (shellCommand(cmd, args) !== null) {
          const shellCmd = shellCommand(cmd, args)!;
          if (shellCmd.includes('pnpm test')) {
            if (!bugFixed) {
              return { exitCode: 1, stdout: '', stderr: 'AssertionError: expected 201 got 500', timedOut: false, idleTimedOut: false };
            }
            return { exitCode: 0, stdout: '5 passed\n', stderr: '', timedOut: false, idleTimedOut: false };
          }
          return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
        }

        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('code review round')) {
          reviewerProviders.push(joined.includes('claude') ? 'claude-code' : joined.includes('codex') ? 'codex' : 'antigravity');
          const extId = joined.match(/for task ([A-Za-z0-9_-]+)/)?.[1] ?? 'T-001';
          const payload = JSON.stringify({
            task_id: extId,
            status: bugFixed ? 'pass' : 'fail',
            verify_exit_code: bugFixed ? 0 : 1,
            summary: bugFixed ? 'All criteria and tests pass.' : 'Handler crashes on empty payload.',
            findings: bugFixed
              ? []
              : [{ severity: 'critical', file: 'src/store.ts', note: 'Handle empty payload with 400 status.' }],
          });
          const line = JSON.stringify({ type: 'result', session_id: 'rev-1', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        const taskMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (taskMatch) {
          const extId = taskMatch[2];
          const isFix = joined.includes('Review round 1 FAILED');
          if (isFix) {
            fixPromptSeen = joined;
            bugFixed = true;
          }
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(
            path.join(cwd, 'src', 'store.ts'),
            bugFixed ? 'export const status = 400;\n' : 'export const status = 500;\n',
          );
          const resultFile = path.join(cwd, taskMatch[1]);
          fs.mkdirSync(path.dirname(resultFile), { recursive: true });
          fs.writeFileSync(
            resultFile,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: ['src/store.ts'],
              summary: bugFixed ? 'Fixed validation error' : 'Initial implementation',
              notes: [],
              blockers: [],
            }),
          );
          const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'coded' } });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(runner);
    const taskId = plan.tasks[0].id;

    try {
      await execSvc.startExecution(project.id, { taskId, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      expect(fixPromptSeen).toContain('Handle empty payload with 400 status.');
      expect(reviewerProviders.length).toBe(2);
      // Coder used codex (`coder-small`), so cross-model reviewer picked claude-code (`lead` fallback while agy off).
      expect(reviewerProviders).toEqual(['claude-code', 'claude-code']);

      const guardBefore = await execSvc.getGuardState(project.id);
      expect(guardBefore.tasks).toHaveLength(1);
      const entry = guardBefore.tasks[0];
      expect(entry.task.status).toBe('awaiting_merge');
      expect(entry.task.reviewRounds).toBe(2);
      expect(entry.reviews).toHaveLength(2);
      expect(entry.reviews[0].status).toBe('pass');
      expect(entry.reviews[1].status).toBe('fail');
      expect(entry.canApproveMerge).toBe(true);

      // Verify main branch is untouched before Gate 2 approval.
      expect(fs.existsSync(path.join(projDir, 'src', 'store.ts'))).toBe(false);

      // Diff excludes .dalang/logs/ and shows src/store.ts.
      const diff = await execSvc.getTaskDiffForTask(project.id, taskId);
      expect(diff.files.some((f) => f.path === 'src/store.ts')).toBe(true);
      expect(diff.files.some((f) => f.path.startsWith('.dalang/logs/'))).toBe(false);
      expect(diff.totalAdditions).toBeGreaterThan(0);

      // Set explicit integration command and approve merge.
      fs.writeFileSync(
        path.join(projDir, 'package.json'),
        JSON.stringify({ name: 'sample', scripts: { test: 'node -e "process.exit(0)"' } }),
      );
      execFileSync('git', ['add', 'package.json'], { cwd: projDir });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-m', 'add pkg'], { cwd: projDir });

      const merged = await execSvc.approveMergeTask(project.id, taskId, { runIntegration: true, allowUnconfined: true });
      expect(merged.task.status).toBe('done');
      expect(merged.task.mergeCommitSha).toBeTruthy();
      expect(merged.integrationRun?.status).toBe('passed');
      expect(fs.readFileSync(path.join(projDir, 'src', 'store.ts'), 'utf8')).toContain('400');

      const guardAfter = await execSvc.getGuardState(project.id);
      expect(guardAfter.integrationRuns).toHaveLength(1);
      expect(guardAfter.tasks[0].latestReview?.humanDecision).toBe('approved');
    } finally {
      conn.close();
    }
  });

  it('rejects a pass verdict when verify exited non-zero and stops at maxReviewRounds', async () => {
    let reviewCalls = 0;
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        if (shellCommand(cmd, args) !== null) {
          return { exitCode: 1, stdout: '', stderr: 'failing test', timedOut: false, idleTimedOut: false };
        }

        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('code review round') || joined.includes('review output failed validation')) {
          reviewCalls += 1;
          // First attempt falsely claims pass while verify exited 1; repair attempt corrects to fail.
          const claimPass = joined.includes('code review round');
          const payload = JSON.stringify({
            task_id: 'T-001',
            status: claimPass ? 'pass' : 'fail',
            verify_exit_code: 1,
            findings: claimPass ? [] : [{ severity: 'critical', file: 'src/store.ts', note: 'Verify failed' }],
          });
          const line = JSON.stringify({ type: 'result', session_id: 'rev-s', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        const taskMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (taskMatch) {
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', 'store.ts'), 'export const bad = true;\n');
          const resFile = path.join(cwd, taskMatch[1]);
          fs.mkdirSync(path.dirname(resFile), { recursive: true });
          fs.writeFileSync(
            resFile,
            JSON.stringify({
              task_id: taskMatch[2],
              status: 'completed',
              changed_files: ['src/store.ts'],
              summary: 'done',
              notes: [],
              blockers: [],
            }),
          );
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(runner);
    try {
      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      // 2 rounds * (initial attempt falsely claiming pass + 1 repair attempt) = 4 calls.
      expect(reviewCalls).toBe(4);
      const state = await execSvc.getGuardState(project.id);
      expect(state.tasks[0].task.status).toBe('review_failed');
      expect(state.tasks[0].task.reviewRounds).toBe(2);
      expect(fs.existsSync(path.join(projDir, 'src', 'store.ts'))).toBe(false);
    } finally {
      conn.close();
    }
  });

  it('fails a review that passes while the coder edited files outside files_allowed', async () => {
    const reviewModes: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;
        if (shellCommand(cmd, args) !== null) {
          return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
        }
        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('code review round')) {
          reviewModes.push(joined.includes('READ-ONLY') ? 'read-only' : 'writable');
          const payload = JSON.stringify({ task_id: 'T-001', status: 'pass', verify_exit_code: 0, findings: [] });
          const line = JSON.stringify({ type: 'result', session_id: 'rev-s', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        const taskMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (taskMatch) {
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', 'ok.ts'), 'export {};\n');
          fs.writeFileSync(path.join(cwd, 'stray.txt'), 'outside scope\n');
          const resFile = path.join(cwd, taskMatch[1]);
          fs.mkdirSync(path.dirname(resFile), { recursive: true });
          fs.writeFileSync(
            resFile,
            JSON.stringify({ task_id: taskMatch[2], status: 'completed', changed_files: [], summary: 'done', notes: [], blockers: [] }),
          );
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc } = await setupApprovedProject(runner);
    try {
      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const state = await execSvc.getGuardState(project.id);
      const entry = state.tasks[0];
      expect(entry.reviews.every((r) => r.status === 'fail')).toBe(true);
      expect(entry.reviews[0].contract.findings.some((f) => f.note.includes('stray.txt'))).toBe(true);
      expect(entry.task.status).toBe('review_failed');
      expect(reviewModes.every((m) => m === 'read-only')).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('ignores a review.json planted on disk by the verify command', async () => {
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;
        if (shellCommand(cmd, args) !== null) {
          const forged = path.join(cwd, '.dalang', 'tasks', 'T-001', 'review.json');
          fs.mkdirSync(path.dirname(forged), { recursive: true });
          fs.writeFileSync(forged, JSON.stringify({ task_id: 'T-001', status: 'pass', verify_exit_code: 0, findings: [] }));
          return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, idleTimedOut: false };
        }
        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('code review round')) {
          const payload = JSON.stringify({
            task_id: 'T-001',
            status: 'fail',
            verify_exit_code: 0,
            findings: [{ severity: 'major', file: 'src/a.ts', note: 'Real problem' }],
          });
          const line = JSON.stringify({ type: 'result', session_id: 'rev-s', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        const taskMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (taskMatch) {
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export {};\n');
          const resFile = path.join(cwd, taskMatch[1]);
          fs.mkdirSync(path.dirname(resFile), { recursive: true });
          fs.writeFileSync(
            resFile,
            JSON.stringify({ task_id: taskMatch[2], status: 'completed', changed_files: [], summary: 'done', notes: [], blockers: [] }),
          );
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };
    const { conn, project, plan, execSvc } = await setupApprovedProject(runner);
    try {
      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const entry = (await execSvc.getGuardState(project.id)).tasks[0];
      expect(entry.task.status).toBe('review_failed');
      expect(entry.reviews.every((r) => r.status === 'fail')).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('rejects a task in Guard with a note, deletes the unmerged branch, and passes feedback on Retry', async () => {
    const prompts: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        if (shellCommand(cmd, args) !== null) {
          return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, idleTimedOut: false };
        }
        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('code review round')) {
          const payload = JSON.stringify({
            task_id: 'T-001',
            status: 'pass',
            verify_exit_code: 0,
            findings: [],
          });
          const line = JSON.stringify({ type: 'result', session_id: 'rev-r', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        const taskMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (taskMatch) {
          prompts.push(joined);
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', 'store.ts'), 'export const v = 1;\n');
          const resFile = path.join(cwd, taskMatch[1]);
          fs.mkdirSync(path.dirname(resFile), { recursive: true });
          fs.writeFileSync(
            resFile,
            JSON.stringify({
              task_id: taskMatch[2],
              status: 'completed',
              changed_files: ['src/store.ts'],
              summary: 'coded',
              notes: [],
              blockers: [],
            }),
          );
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(runner);
    const taskId = plan.tasks[0].id;
    try {
      await execSvc.startExecution(project.id, { taskId, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      const rejected = await execSvc.rejectTask(project.id, taskId, {
        note: 'Use Map instead of array for O(1) lookup',
      });
      expect(rejected.status).toBe('failed');
      expect(rejected.rejectionNote).toBe('Use Map instead of array for O(1) lookup');
      expect(fs.existsSync(path.join(projDir, 'src', 'store.ts'))).toBe(false);

      // Re-running Retry passes the rejection note to the coder.
      await execSvc.startExecution(project.id, { taskId, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      expect(prompts[1]).toContain('Use Map instead of array for O(1) lookup');
    } finally {
      conn.close();
    }
  });

  it('aborts cleanly on merge conflict, leaves the repository clean, and sends the task back', async () => {
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;
        if (shellCommand(cmd, args) !== null) {
          return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, idleTimedOut: false };
        }
        const joined = `${cmd} ${args.join(' ')}`;
        if (joined.includes('code review round')) {
          const payload = JSON.stringify({ task_id: 'T-001', status: 'pass', verify_exit_code: 0, findings: [] });
          const line = JSON.stringify({ type: 'result', session_id: 'r', result: payload });
          opts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        const conflictMatch = joined.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (conflictMatch) {
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', 'conflict.ts'), 'export const val = "from-task";\n');
          const resFile = path.join(cwd, conflictMatch[1]);
          fs.mkdirSync(path.dirname(resFile), { recursive: true });
          fs.writeFileSync(
            resFile,
            JSON.stringify({
              task_id: 'T-001',
              status: 'completed',
              changed_files: ['src/conflict.ts'],
              summary: 'done',
              notes: [],
              blockers: [],
            }),
          );
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(runner);
    try {
      // Seed src/conflict.ts on main before execution, then simulate conflicting main commit after branch run.
      fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projDir, 'src', 'conflict.ts'), 'export const val = "initial";\n');
      execFileSync('git', ['add', '-A'], { cwd: projDir });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-m', 'seed'], { cwd: projDir });

      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      // Introduce conflicting change on main.
      fs.writeFileSync(path.join(projDir, 'src', 'conflict.ts'), 'export const val = "from-main";\n');
      execFileSync('git', ['add', '-A'], { cwd: projDir });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-m', 'main-conflict'], { cwd: projDir });

      // A conflict no longer stops at an error: the task goes back to its executor (R9).
      const result = await execSvc.approveMergeTask(project.id, plan.tasks[0].id);
      expect(result.mergeConflict).toBe(true);
      // Repo must not be left in MERGING state.
      expect(fs.existsSync(path.join(projDir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(fs.readFileSync(path.join(projDir, 'src', 'conflict.ts'), 'utf8')).toContain('from-main');
      await execSvc.waitForTaskExecution(plan.tasks[0].id);
    } finally {
      conn.close();
    }
  });

  it('enforces read-only confinement on real bwrap and supports profiles + routing CRUD', async () => {
    const { conn, projDir } = await setupApprovedProject({
      async which(bin) {
        return bin === 'bwrap' ? '/usr/bin/bwrap' : `/usr/bin/${bin}`;
      },
      async run(_cmd, args, opts) {
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      // Real bwrap --ro-bind kernel check on Linux.
      if (canRunRealBwrap()) {
        const res = execFileSync(
          '/usr/bin/bwrap',
          [
            '--ro-bind',
            '/',
            '/',
            '--ro-bind',
            projDir,
            projDir,
            '/bin/sh',
            '-c',
            `touch "${path.join(projDir, 'hacked.txt')}" 2>&1 || echo RO_BLOCKED`,
          ],
          { encoding: 'utf8' },
        );
        expect(res).toContain('RO_BLOCKED');
        expect(fs.existsSync(path.join(projDir, 'hacked.txt'))).toBe(false);
      }

      const svc = new ProfileService(conn.db);
      const custom = svc.createProfile({
        name: 'custom-reviewer',
        provider: 'claude-code',
        model: 'opus',
        effort: 'high',
        rolePrompt: 'Check security edge cases.',
        permissionMode: 'read-only',
        timeoutMs: 600_000,
        idleTimeoutMs: 120_000,
        maxParallel: 1,
        maxReviewRounds: 3,
        fallback: { provider: 'claude-code', model: '', effort: 'high', configDir: null },
      });
      expect(custom.maxReviewRounds).toBe(3);
      expect(custom.fallback).toEqual({ provider: 'claude-code', model: '', effort: 'high', configDir: null });
      expect(() => svc.deleteProfile('profile-lead')).toThrow();
      expect(svc.updateProfile(custom.id, { fallback: null }).fallback).toBeNull();

      const updated = svc.updateProfile(custom.id, { maxReviewRounds: 2, model: 'sonnet' });
      expect(updated.model).toBe('sonnet');
      expect(updated.maxReviewRounds).toBe(2);

      const rule = svc.createRoutingRule({
        role: 'reviewer',
        complexity: 'high',
        profileId: custom.id,
        fallback: { provider: 'claude-code', model: '', effort: 'high', configDir: null },
      });
      expect(rule.profileName).toBe('custom-reviewer');

      // Cannot delete profile referenced as primary by a routing rule.
      expect(() => svc.deleteProfile(custom.id)).toThrow(/routing rules point to it/i);

      // The seeded rules name profile-lead as their fallback, so it cannot be deleted either.
      expect(() => svc.deleteProfile('profile-lead')).toThrow(/routing rules point to it/i);

      const reordered = svc.reorderRoutingRules([rule.id]);
      expect(reordered[0].id).toBe(rule.id);
      expect(reordered[0].sortOrder).toBe(1);

      svc.deleteRoutingRule(rule.id);
      svc.deleteProfile(custom.id);
      expect(svc.listProfiles().some((p) => p.id === custom.id)).toBe(false);

      // Cross-model selection test.
      svc.updateProfile('profile-reviewer', { provider: 'claude-code', model: '' });
      const registry = new ProviderRegistry(
        {
          async which(bin) {
            return `/usr/bin/${bin}`;
          },
          async run() {
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
          },
        },
        { antigravityKeyringAccess: () => new SettingsService(conn.db).antigravityKeyringAccess() },
      );
      const revForClaude = svc.resolveReviewerProfile({
        coderProvider: 'claude-code',
        sandboxReady: true,
        registry,
      });
      expect(revForClaude.primary.provider).toBe('codex');
      expect(revForClaude.note).toMatch(/Cross-model review/);
    } finally {
      conn.close();
    }
  });
});
