import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { runs } from '../db/schema.js';
import { StatisticsService } from '../services/stats.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('Per-step run timing breakdown and slot-wait exclusion (PRD v0.15 P4)', () => {
  it('records setup/slot/agent and verify/review phase timings, excludes slotWaitMs from run duration, and aggregates per project', async () => {
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const review = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (review) {
          await new Promise((r) => setTimeout(r, 15));
          return review;
        }
        const prompt = args.join(' ');
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (match) {
          await new Promise((r) => setTimeout(r, 20));
          fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, 'src', 'timed.ts'), 'export const timed = true;\n');
          fs.mkdirSync(path.dirname(path.join(opts.cwd, match[1])), { recursive: true });
          fs.writeFileSync(
            path.join(opts.cwd, match[1]),
            JSON.stringify({
              task_id: match[2],
              status: 'completed',
              changed_files: ['src/timed.ts'],
              summary: 'Implemented timed module',
              notes: [],
              blockers: [],
              verify_exit_code: 0,
            }),
          );
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, execSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Timed task', complexity: 'medium', files_allowed: ['src/**'] },
    ]);

    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      const execState = await execSvc.getExecutionState(project.id);
      const executeRun = execState.runs.find((r) => r.kind === 'execute');
      const reviewRun = execState.runs.find((r) => r.kind === 'review');

      expect(executeRun).toBeDefined();
      expect(executeRun?.timing).toBeTruthy();
      expect(executeRun?.timing?.setupMs).toBeGreaterThanOrEqual(0);
      expect(executeRun?.timing?.agentMs).toBeGreaterThanOrEqual(10);
      expect(executeRun?.timing?.verifyMs).toBeNull();
      expect(executeRun?.timing?.reviewMs).toBeNull();

      expect(reviewRun).toBeDefined();
      expect(reviewRun?.timing).toBeTruthy();
      expect(reviewRun?.timing?.verifyMs).toBeGreaterThanOrEqual(0);
      expect(reviewRun?.timing?.reviewMs).toBeGreaterThanOrEqual(10);
      expect(reviewRun?.timing?.setupMs).toBeNull();

      // Verify slotWaitMs is subtracted from run durationMs (both in ExecutionStateDTO and StatisticsService).
      const startedIso = '2026-11-27T10:00:00.000Z';
      const finishedIso = '2026-11-27T10:00:10.000Z'; // 10_000 ms wall time
      conn.db
        .update(runs)
        .set({
          startedAt: startedIso,
          finishedAt: finishedIso,
          slotWaitMs: 4000,
          setupMs: 1000,
          agentMs: 5000,
        })
        .where(eq(runs.id, executeRun!.id))
        .run();

      const updatedState = await execSvc.getExecutionState(project.id);
      const updatedExecRun = updatedState.runs.find((r) => r.id === executeRun!.id)!;
      expect(updatedExecRun.durationMs).toBe(6000); // 10_000 - 4_000 slot wait

      const statsSvc = new StatisticsService(conn.db);
      const stats = statsSvc.getUsageStatistics({ projectId: project.id });
      const projStats = stats.projects.find((p) => p.projectId === project.id);
      expect(projStats?.timing).toBeDefined();
      expect(projStats?.timing?.slotWaitMs).toBeGreaterThanOrEqual(4000);
      expect(projStats?.timing?.setupMs).toBeGreaterThanOrEqual(1000);
      expect(projStats?.timing?.agentMs).toBeGreaterThanOrEqual(5000);
      expect(projStats?.timing?.reviewMs).toBeGreaterThanOrEqual(10);
    } finally {
      conn.close();
    }
  });
});
