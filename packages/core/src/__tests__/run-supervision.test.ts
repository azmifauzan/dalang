import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('Run supervision Lead turns at key boundaries (PRD v0.15 U10, B22)', () => {
  it('runs a read-only Lead supervision turn on review failure and deduplicates repeated triggers without mutating plans or work', async () => {
    const supervisionPrompts: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const prompt = args.join(' ');
        if (/Run supervision check/i.test(prompt)) {
          supervisionPrompts.push(prompt);
          // Even if the model tries to return destructive or plan-mutating JSON, supervision only posts read-only text.
          const payload = JSON.stringify({
            text: 'Supervision: T-001 failed review. Recommend inspecting the finding and using /continue T-001.',
            action: 'replace_plan',
            delete_worktrees: true,
            start_execution: true,
          });
          const frame = JSON.stringify({
            type: 'result',
            session_id: 'lead-sup-1',
            result: payload,
          });
          opts.onStdoutLine?.(frame);
          return { exitCode: 0, stdout: `${frame}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const review = handleVerifyAndReviewCalls(cmd, args, opts, 'fail');
        if (review) return review;
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (match) {
          fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, 'src', 'sup.ts'), 'export const sup = 1;\n');
          fs.mkdirSync(path.dirname(path.join(opts.cwd, match[1])), { recursive: true });
          fs.writeFileSync(
            path.join(opts.cwd, match[1]),
            JSON.stringify({
              task_id: match[2],
              status: 'completed',
              changed_files: ['src/sup.ts'],
              summary: 'Wrote sup.ts',
              notes: [],
              blockers: [],
              verify_exit_code: 0,
            }),
          );
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, leadSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Supervised task', complexity: 'low', files_allowed: ['src/**'] },
    ]);

    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      // Should have triggered supervision on review_failed and/or run_ended.
      expect(supervisionPrompts.length).toBeGreaterThanOrEqual(1);
      const beforeCount = supervisionPrompts.length;

      // Repeating the same boundary key must be deduplicated (zero extra quota).
      const dup = await leadSvc.superviseRunBoundary(project.id, plan.sessionId, {
        kind: 'review_failed',
        targetId: `${plan.tasks[0].id}:r1`,
        summary: 'Duplicate trigger',
      });
      expect(dup).toBeNull();
      expect(supervisionPrompts.length).toBe(beforeCount);

      // Plan and task branch remain completely untouched (not replaced, not deleted, not restarted).
      const currentPlan = leadSvc.getPlan(project.id, plan.sessionId);
      expect(currentPlan?.id).toBe(plan.id);
      expect(currentPlan?.version).toBe(plan.version);
      expect(currentPlan?.status).toBe('approved');
      expect(currentPlan?.tasks[0].status).toBe('review_failed');
      expect(currentPlan?.tasks[0].branchName).toBeTruthy();

      const detail = leadSvc.getSessionDetail(project.id, plan.sessionId);
      const leadAdvice = detail.messages.find(
        (m) =>
          m.role === 'lead' &&
          m.type === 'ask' &&
          JSON.stringify(m.content).includes('Supervision: T-001 failed review'),
      );
      expect(leadAdvice).toBeDefined();
    } finally {
      conn.close();
    }
  });
});
