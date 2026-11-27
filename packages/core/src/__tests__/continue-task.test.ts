import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomReportContent } from '@dalang/shared';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { cleanupTempDirs, handleLeadCalls, handleVerifyAndReviewCalls, setupApprovedProject } from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('continue a task that stopped short (B19, U7)', () => {
  it('keeps the branch after the last failed review, sends the findings, and reaches the merge gate', async () => {
    const coderPrompts: string[] = [];
    let verdict: 'pass' | 'fail' = 'fail';
    let keptWork = false;
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const review = handleVerifyAndReviewCalls(cmd, args, opts, verdict);
        if (review) return review;
        const prompt = args.join(' ');
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (!match) return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        coderPrompts.push(prompt);
        const file = path.join(opts.cwd, 'src', `pass-${coderPrompts.length}.ts`);
        keptWork = fs.existsSync(path.join(opts.cwd, 'src', 'pass-1.ts'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'export {};\n');
        const result = path.join(opts.cwd, match[1]);
        fs.mkdirSync(path.dirname(result), { recursive: true });
        fs.writeFileSync(result, JSON.stringify({ task_id: match[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }));
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };
    const { conn, project, plan, execSvc, leadSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Feature', complexity: 'low', depends_on: [], files_allowed: ['src/**'] },
    ]);
    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const taskId = plan.tasks[0].id;
      const status = () => leadSvc.getPlan(project.id, plan.sessionId)!.tasks[0].status;
      expect(status()).toBe('review_failed');
      const before = coderPrompts.length;

      verdict = 'pass';
      await execSvc.continueTask(project.id, taskId, { note: 'Mind the empty case', allowUnconfined: true });
      await execSvc.waitForTaskExecution(taskId);

      const prompt = coderPrompts[before];
      expect(prompt).toContain('Fix these open review findings');
      expect(prompt).toContain('src/store.ts: Missing edge case handling');
      expect(prompt).toContain('Mind the empty case');
      expect(keptWork).toBe(true);
      expect(status()).toBe('awaiting_merge');
      const events = leadSvc.getSessionDetail(project.id, plan.sessionId).messages
        .filter((m) => m.type === 'report').map((m) => (m.content as RoomReportContent).event);
      expect(events).toContain('review_verdict');
      await expect(execSvc.continueTask(project.id, taskId)).rejects.toThrow(/no unfinished work to continue/);
    } finally {
      conn.close();
    }
  });
});
