import { execFileSync } from 'node:child_process';
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('merge conflicts (B9, R9)', () => {
  it('sends a conflicted merge back to the executor, then merges the resolved branch', async () => {
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
        if (taskMatch) {
          coderPrompts.push(prompt);
          const file = path.join(cwd, 'src', 'shared.ts');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('<<<<<<<')) {
            // The executor resolves the conflict by keeping both sides.
            fs.writeFileSync(file, 'export const fromMain = 1;\nexport const fromTask = 2;\n');
          } else {
            fs.writeFileSync(file, 'export const fromTask = 2;\n');
          }
          const resultFile = path.join(cwd, taskMatch[1]);
          fs.mkdirSync(path.dirname(resultFile), { recursive: true });
          fs.writeFileSync(
            resultFile,
            JSON.stringify({
              task_id: taskMatch[2],
              status: 'completed',
              summary: 'Done',
              notes: [],
              blockers: [],
              verify_command: 'pnpm test',
              verify_exit_code: 0,
            }),
          );
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const { conn, project, plan, execSvc, leadSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Shared module', complexity: 'low', depends_on: [], files_allowed: ['src/**'] },
    ]);
    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const taskId = plan.tasks[0].id;
      expect((await execSvc.getExecutionState(project.id)).dispatchPreviews[0].status).toBe('awaiting_merge');

      // Meanwhile the main branch adds the same file with other content.
      fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projDir, 'src', 'shared.ts'), 'export const fromMain = 1;\n');
      git(projDir, 'add', 'src/shared.ts');
      git(projDir, 'commit', '-q', '-m', 'main adds shared');
      const mainBefore = git(projDir, 'rev-parse', 'HEAD');

      const first = await execSvc.approveMergeTask(project.id, taskId, { allowUnconfined: true, runIntegration: false });
      expect(first.mergeConflict).toBe(true);
      expect(git(projDir, 'rev-parse', 'HEAD')).toBe(mainBefore);
      expect(git(projDir, 'status', '--porcelain', '--untracked-files=no')).toBe('');

      await execSvc.waitForTaskExecution(taskId);
      expect(coderPrompts).toHaveLength(2);
      expect(coderPrompts[1]).toContain('src/shared.ts');
      expect(coderPrompts[1]).toContain('conflict marker');
      const reports = leadSvc
        .getSessionDetail(project.id, plan.sessionId)
        .messages.filter((m) => m.type === 'report')
        .map((m) => (m.content as { event: string }).event);
      expect(reports).toContain('merge_conflict');
      expect((await execSvc.getExecutionState(project.id)).dispatchPreviews[0].status).toBe('awaiting_merge');

      const second = await execSvc.approveMergeTask(project.id, taskId, { allowUnconfined: true, runIntegration: false });
      expect(second.mergeConflict).toBeUndefined();
      expect(fs.readFileSync(path.join(projDir, 'src', 'shared.ts'), 'utf8')).toBe(
        'export const fromMain = 1;\nexport const fromTask = 2;\n',
      );
    } finally {
      conn.close();
    }
  });
});
