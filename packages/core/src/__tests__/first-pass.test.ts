import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { cleanupTempDirs, handleLeadCalls, handleVerifyAndReviewCalls, setupApprovedProject } from './exec-helpers.js';

afterEach(cleanupTempDirs);

describe('first review pass (B25, P1) and run timing (P4)', () => {
  it('tells the executor what the reviewer checks, keeps the reviewer from rerunning verify, and logs the time split', async () => {
    const prompts: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        if (/code review round/.test(args.join(' '))) prompts.push(args.join(' '));
        const review = handleVerifyAndReviewCalls(cmd, args, opts, prompts.filter((p) => /code review round/.test(p)).length > 1 ? 'pass' : 'fail');
        if (review) return review;
        const prompt = args.join(' ');
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (!match) return ok;
        prompts.push(prompt);
        fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, 'src', `p${prompts.length}.ts`), 'export {};\n');
        fs.mkdirSync(path.dirname(path.join(opts.cwd, match[1])), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, match[1]), JSON.stringify({ task_id: match[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }));
        return ok;
      },
    };
    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Medium task', complexity: 'medium', files_allowed: ['src/**'] },
    ]);
    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const [execute, review, fix] = prompts;
      expect(execute).toContain('review your own work as the independent reviewer will');
      expect(review).toContain('DALANG already ran the verify command in this worktree');
      expect(fix).toContain('Fix the cause of each finding');
      expect(fix).toContain('review your own work as the independent reviewer will');
      const logs = fs.readdirSync(path.join(projDir, '.dalang', 'sessions', plan.sessionId, 'logs'));
      const runLog = fs.readFileSync(path.join(projDir, '.dalang', 'sessions', plan.sessionId, 'logs', logs.find((f) => f.startsWith('run-'))!), 'utf8');
      expect(runLog).toMatch(/\[dalang\] Time: [\d.]+s total; slot wait [\d.]+s, worktree setup [\d.]+s, agent [\d.]+s, DALANG before and after the agent [\d.]+s/);
    } finally {
      conn.close();
    }
  });

  it('leaves the self-check out of a low task, which usually passes as it is', async () => {
    const prompts: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const review = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (review) return review;
        const prompt = args.join(' ');
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (match) {
          prompts.push(prompt);
          fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, 'src', 'a.ts'), 'export {};\n');
          fs.mkdirSync(path.dirname(path.join(opts.cwd, match[1])), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, match[1]), JSON.stringify({ task_id: match[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }));
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };
    const { conn, project, execSvc } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Low task', complexity: 'low', files_allowed: ['src/**'] },
    ]);
    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      expect(prompts[0]).toContain('Acceptance criteria');
      expect(prompts[0]).not.toContain('review your own work');
    } finally {
      conn.close();
    }
  });
});
