import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { providerEvents, runs, tasks } from '../db/schema.js';
import { ProviderRegistry } from '../adapters/registry.js';
import type { DalangEvent } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  makeTempDir,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('ExecutionService (v0.2 Jalan + v0.3 Kawal)', () => {
  it('runs tasks in dependency order through review, Guard merge, checkpoints, logs, and scope warnings', async () => {
    const executionOrder: string[] = [];

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const promptArg = args.find((a) => a.includes('.dalang/tasks/')) ?? args.join(' ');
        const taskMatch = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        if (taskMatch) {
          const extId = taskMatch[1];
          executionOrder.push(extId);
          const resultFile = path.join(cwd, '.dalang', 'tasks', extId, 'result.json');
          fs.mkdirSync(path.dirname(resultFile), { recursive: true });
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });

          if (extId === 'T-001') {
            fs.writeFileSync(path.join(cwd, 'src', 'model.ts'), 'export interface Item { id: string; }\n');
          } else {
            fs.writeFileSync(path.join(cwd, 'src', 'routes.ts'), 'export const routes = [];\n');
            // Intentionally touch a file outside files_allowed (`src/**`) to verify scopeWarnings.
            fs.writeFileSync(path.join(cwd, 'UNEXPECTED.txt'), 'out of scope\n');
          }

          fs.writeFileSync(
            resultFile,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: [extId === 'T-001' ? 'src/model.ts' : 'src/routes.ts'],
              summary: `Finished ${extId}`,
              notes: [],
              blockers: [],
              verify_command: 'pnpm test',
              verify_exit_code: 0,
            }),
          );

          const logLine = JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: `Executed ${extId}` },
          });
          opts.onStdoutLine?.(logLine);
          return { exitCode: 0, stdout: `${logLine}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, events, project, plan, execSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Item model', complexity: 'low', depends_on: [], files_allowed: ['src/**'] },
      { id: 'T-002', title: 'Item routes', complexity: 'low', depends_on: ['T-001'], files_allowed: ['src/**'] },
    ]);

    const capturedEvents: DalangEvent[] = [];
    events.onEvent((ev) => capturedEvents.push(ev));

    try {
      const started = await execSvc.startExecution(project.id, { allowUnconfined: true });
      expect(started.started).toBe(true);
      expect(started.queueMode).toBe(true);
      await execSvc.waitForProjectExecution(project.id);

      // T-001 finishes coding + review and waits in Guard before T-002 can unlock.
      expect(executionOrder).toEqual(['T-001']);
      let state = await execSvc.getExecutionState(project.id);
      expect(state.dispatchPreviews[0].status).toBe('awaiting_merge');
      expect(state.dispatchPreviews[1].eligible).toBe(false);
      // Main branch remains clean until Gate 2 merge approval.
      expect(fs.existsSync(path.join(projDir, 'src', 'model.ts'))).toBe(false);

      await execSvc.approveMergeTask(project.id, plan.tasks[0].id);
      expect(fs.existsSync(path.join(projDir, 'src', 'model.ts'))).toBe(true);

      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      // The stray file fails both review rounds, so T-002 coded twice and stops in Guard.
      expect(executionOrder).toEqual(['T-001', 'T-002', 'T-002']);

      state = await execSvc.getExecutionState(project.id);
      expect(state.activeRun).toBeNull();
      expect(state.dispatchPreviews[1].status).toBe('review_failed');

      const t2Run = state.runs.find((r) => r.taskExternalId === 'T-002' && r.kind === 'execute')!;
      expect(t2Run.status).toBe('completed');
      expect(t2Run.commitBefore).toBeTruthy();
      expect(t2Run.commitAfter).toBeTruthy();
      expect(t2Run.commitBefore).not.toBe(t2Run.commitAfter);
      expect(t2Run.scopeWarnings).toEqual(['Modified outside files_allowed: UNEXPECTED.txt']);
      expect(t2Run.result?.summary).toBe('Finished T-002');

      const logRes = await execSvc.getRunLog(project.id, t2Run.id);
      expect(logRes.content).toContain('Executed T-002');

      await expect(execSvc.approveMergeTask(project.id, plan.tasks[1].id)).rejects.toThrow(/failed review/);
      await execSvc.approveMergeTask(project.id, plan.tasks[1].id, { allowFailedReview: true });
      state = await execSvc.getExecutionState(project.id);
      expect(state.dispatchPreviews.every((d) => d.status === 'done')).toBe(true);

      expect(capturedEvents.some((e) => e.type === 'run.started')).toBe(true);
      expect(capturedEvents.some((e) => e.type === 'run.log')).toBe(true);
      expect(capturedEvents.some((e) => e.type === 'run.finished')).toBe(true);
      expect(capturedEvents.some((e) => e.type === 'review.finished')).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('falls back to backup profile when primary hits rate limit (F-13)', async () => {
    const providersUsed: string[] = [];

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const joined = `${cmd} ${args.join(' ')}`;
        const isCodex = joined.includes('codex');
        providersUsed.push(isCodex ? 'codex' : 'claude');

        if (isCodex) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: '429 rate limit exceeded for codex',
            timedOut: false,
            idleTimedOut: false,
          };
        }

        const taskMatch = joined.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        const extId = taskMatch ? taskMatch[1] : 'T-001';
        const resultFile = path.join(cwd, '.dalang', 'tasks', extId, 'result.json');
        fs.mkdirSync(path.dirname(resultFile), { recursive: true });
        fs.writeFileSync(
          resultFile,
          JSON.stringify({
            task_id: extId,
            status: 'completed',
            changed_files: ['src/store.ts'],
            summary: 'Completed on fallback profile',
            notes: [],
            blockers: [],
          }),
        );
        const line = JSON.stringify({ type: 'result', session_id: 'fb-sess-1', result: 'done' });
        opts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc } = await setupApprovedProject(runner);

    try {
      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      expect(providersUsed).toEqual(['codex', 'claude']);

      const state = await execSvc.getExecutionState(project.id);
      const coderRuns = state.runs.filter((r) => r.kind === 'execute');
      expect(coderRuns).toHaveLength(2);
      const fbRun = coderRuns[0];
      const primaryRun = coderRuns[1];
      expect(primaryRun.status).toBe('failed');
      expect(primaryRun.failureReason).toMatch(/rate limit/i);
      expect(fbRun.status).toBe('completed');
      expect(fbRun.usedFallback).toBe(true);
      expect(fbRun.provider).toBe('claude-code');

      const eventsRows = conn.db.select().from(providerEvents).all();
      expect(eventsRows.some((e) => e.provider === 'codex' && e.type === 'rate_limit')).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('supports stop, session resume, and one-click checkpoint rollback (F-15, F-17)', async () => {
    let runCall = 0;
    let resumeReceivedSession: string | null = null;
    let releaseBlockedRun!: () => void;
    const blockedRunStarted = new Promise<void>((res) => {
      releaseBlockedRun = res;
    });

    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        runCall++;
        const joined = `${cmd} ${args.join(' ')}`;

        if (runCall === 1) {
          const tLine = JSON.stringify({ type: 'thread.started', thread_id: 'codex-resume-99' });
          opts.onStdoutLine?.(tLine);
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', 'partial.ts'), 'export const partial = 1;\n');
          releaseBlockedRun();

          return await new Promise<RunCommandResult>((resolve) => {
            opts.signal?.addEventListener(
              'abort',
              () => {
                resolve({
                  exitCode: null,
                  stdout: `${tLine}\n`,
                  stderr: '',
                  timedOut: false,
                  idleTimedOut: false,
                  aborted: true,
                });
              },
              { once: true },
            );
          });
        }

        const resumeMatch = joined.match(/exec resume ([^\s]+)/);
        resumeReceivedSession = resumeMatch ? resumeMatch[1] : null;
        const resultFile = path.join(cwd, '.dalang', 'tasks', 'T-001', 'result.json');
        fs.mkdirSync(path.dirname(resultFile), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'src', 'store.ts'), 'export const ready = true;\n');
        fs.writeFileSync(
          resultFile,
          JSON.stringify({
            task_id: 'T-001',
            status: 'completed',
            changed_files: ['src/store.ts'],
            summary: 'Resumed and completed',
            notes: [],
            blockers: [],
          }),
        );
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(runner);
    const taskId = plan.tasks[0].id;

    try {
      await execSvc.startExecution(project.id, { taskId, allowUnconfined: true });
      await blockedRunStarted;
      const stopped = await execSvc.stopExecution(project.id);
      expect(stopped.stopped).toBe(true);

      let state = await execSvc.getExecutionState(project.id);
      expect(state.runs[0].status).toBe('stopped');
      expect(state.runs[0].cliSessionId).toBe('codex-resume-99');
      expect(state.dispatchPreviews[0].status).toBe('stopped');

      await execSvc.startExecution(project.id, {
        taskId,
        allowUnconfined: true,
        resumeSession: true,
      });
      await execSvc.waitForProjectExecution(project.id);

      expect(resumeReceivedSession).toBe('codex-resume-99');
      state = await execSvc.getExecutionState(project.id);
      const completedCoderRun = state.runs.find((r) => r.kind === 'execute' && r.status === 'completed')!;
      expect(state.dispatchPreviews[0].status).toBe('awaiting_merge');

      // Merge first, then test checkpoint rollback across merged main commits.
      await execSvc.approveMergeTask(project.id, taskId);
      expect(fs.existsSync(path.join(projDir, 'src', 'store.ts'))).toBe(true);

      const rolled = await execSvc.rollbackRun(project.id, completedCoderRun.id);
      expect(rolled.status).toBe('rolled_back');
      expect(fs.existsSync(path.join(projDir, 'src', 'store.ts'))).toBe(false);
      // .dalang logs remain preserved for inspection.
      expect(fs.existsSync(path.join(projDir, completedCoderRun.logPath))).toBe(true);

      await expect(execSvc.rollbackRun(project.id, completedCoderRun.id)).rejects.toThrow(
        /already been rolled back/i,
      );

      execSvc.assignTaskProfile(project.id, taskId, 'profile-coder-heavy');
      await expect(
        execSvc.startExecution(project.id, { taskId, allowUnconfined: true, resumeSession: true }),
      ).rejects.toThrow(/belongs to codex/i);
    } finally {
      conn.close();
    }
  });

  it('ignores planted git hooks, reconciles interrupted runs on startup, and cascades rollback across later runs', async () => {
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const cwd = opts.cwd;
        const leadRes = handleLeadCalls(cwd, args, opts);
        if (leadRes) return leadRes;

        const reviewRes = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (reviewRes) return reviewRes;

        const promptArg = args.find((a) => a.includes('.dalang/tasks/')) ?? args.join(' ');
        const taskMatch = promptArg.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/);
        if (taskMatch) {
          const extId = taskMatch[1];
          const resFile = path.join(cwd, '.dalang', 'tasks', extId, 'result.json');
          fs.mkdirSync(path.dirname(resFile), { recursive: true });
          fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'src', `${extId}.ts`), `export const id = "${extId}";\n`);
          fs.writeFileSync(
            resFile,
            JSON.stringify({
              task_id: extId,
              status: 'completed',
              changed_files: [`src/${extId}.ts`],
              summary: `Done ${extId}`,
              notes: [],
              blockers: [],
            }),
          );
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, events, project, plan, leadSvc, execSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Step 1', complexity: 'low', depends_on: [] },
      { id: 'T-002', title: 'Step 2', complexity: 'low', depends_on: ['T-001'] },
    ]);

    try {
      const hookMarker = path.join(projDir, 'HOOK_EXECUTED');
      const hooksDir = path.join(projDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir, 'pre-commit'),
        `#!/bin/sh\ntouch "${hookMarker}"\nexit 1\n`,
        { mode: 0o755 },
      );

      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      await execSvc.approveMergeTask(project.id, plan.tasks[0].id);

      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      await execSvc.approveMergeTask(project.id, plan.tasks[1].id);

      expect(fs.existsSync(hookMarker)).toBe(false);

      const stateAfterBoth = await execSvc.getExecutionState(project.id);
      const t1Run = stateAfterBoth.runs.find((r) => r.taskExternalId === 'T-001' && r.kind === 'execute')!;

      await execSvc.rollbackRun(project.id, t1Run.id);
      const stateAfterRollback = await execSvc.getExecutionState(project.id);
      expect(stateAfterRollback.runs.every((r) => r.status === 'rolled_back')).toBe(true);
      expect(stateAfterRollback.dispatchPreviews.every((d) => d.status === 'approved')).toBe(true);
      expect(fs.existsSync(path.join(projDir, 'src', 'T-002.ts'))).toBe(false);

      const now = new Date().toISOString();
      conn.db
        .insert(runs)
        .values({
          id: 'orphan-run-1',
          projectId: project.id,
          taskId: plan.tasks[0].id,
          profileId: 'profile-coder-small',
          provider: 'codex',
          model: null,
          kind: 'review',
          branchName: 'dalang/T-001',
          status: 'running',
          cliSessionId: null,
          attempt: 99,
          usedFallback: false,
          startedAt: now,
          finishedAt: null,
          exitCode: null,
          failureReason: null,
          commitBefore: null,
          commitAfter: null,
          logPath: '.dalang/logs/orphan.log',
          resultPath: null,
          scopeWarningsJson: '[]',
        })
        .run();
      conn.db
        .update(tasks)
        .set({ status: 'reviewing', updatedAt: now })
        .where(eq(tasks.id, plan.tasks[0].id))
        .run();

      const restartedExec = new ExecutionService(conn.db, new ProviderRegistry(runner), leadSvc, events);
      const recovered = await restartedExec.getExecutionState(project.id);
      expect(recovered.activeRun).toBeNull();
      expect(recovered.runs[0]).toMatchObject({
        id: 'orphan-run-1',
        status: 'stopped',
        failureReason: 'Interrupted by server restart',
      });
      expect(recovered.dispatchPreviews[0].status).toBe('stopped');
    } finally {
      conn.close();
    }
  });
});
