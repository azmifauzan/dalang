import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import type { RoomReportContent } from '@dalang/shared';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('scope requests (B13, R10)', () => {
  it('asks to allow files outside files_allowed, then continues the task on its branch', async () => {
    const coderPrompts: string[] = [];
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

        const prompt = args.join(' ');
        const taskMatch = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (!taskMatch) return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        coderPrompts.push(prompt);
        const allowed = prompt.includes('The user allowed these files');
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'src', 'feature.ts'), 'export const feature = 1;\n');
        if (allowed) {
          fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true });
          fs.writeFileSync(path.join(cwd, 'lib', 'runner.ts'), 'export const runner = 1;\n');
        }
        const resultFile = path.join(cwd, taskMatch[1]);
        fs.mkdirSync(path.dirname(resultFile), { recursive: true });
        fs.writeFileSync(
          resultFile,
          JSON.stringify(
            allowed
              ? { task_id: taskMatch[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }
              : {
                  task_id: taskMatch[2],
                  status: 'blocked',
                  summary: 'Needs the runner',
                  notes: [],
                  blockers: ['The review finding needs lib/runner.ts'],
                  // src/feature.ts is already allowed, so only lib/runner.ts is asked for.
                  needs_files: ['lib/runner.ts', 'src/feature.ts'],
                },
          ),
        );
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, leadSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Feature', complexity: 'low', depends_on: [], files_allowed: ['src/**'] },
    ]);
    try {
      expect(coderPrompts).toHaveLength(0);
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      expect(coderPrompts[0]).toContain('needs_files');
      const taskId = plan.tasks[0].id;
      const reports = () =>
        leadSvc
          .getSessionDetail(project.id, plan.sessionId)
          .messages.filter((m) => m.type === 'report')
          .map((m) => m.content as RoomReportContent);
      const request = reports().filter((r) => r.event === 'scope_request');
      expect(request).toHaveLength(1);
      expect(request[0].needsFiles).toEqual(['lib/runner.ts']);
      expect(reports().some((r) => r.event === 'task_failed')).toBe(false);

      // Only files the task asked for can be allowed.
      await expect(execSvc.allowTaskScope(project.id, taskId, { files: ['secrets/.env'] })).rejects.toThrow(/None of these files were requested/);

      await execSvc.allowTaskScope(project.id, taskId, { files: ['lib/runner.ts'], allowUnconfined: true });
      await execSvc.waitForTaskExecution(taskId);
      expect(coderPrompts[1]).toContain('The user allowed these files for this task: lib/runner.ts');
      const task = leadSvc.getPlan(project.id, plan.sessionId)!.tasks[0];
      expect(task.filesAllowed).toEqual(['src/**', 'lib/runner.ts']);
      expect(task.status).toBe('awaiting_merge');
    } finally {
      conn.close();
    }
  });
});
