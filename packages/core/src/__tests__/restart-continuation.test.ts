import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { runs, tasks } from '../db/schema.js';
import { ExecutionService } from '../services/executor.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  setupApprovedProject,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

function makeRunner(prompts: string[]): CliRunner {
  return {
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
      prompts.push(prompt);
      fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
      fs.appendFileSync(path.join(cwd, 'src', 'work.ts'), `// pass ${prompts.length}\n`);
      const resultFile = path.join(cwd, taskMatch[1]);
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(
        resultFile,
        JSON.stringify({ task_id: taskMatch[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }),
      );
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
    },
  };
}

/** Puts the task back as if the server died while its run was going. */
function simulateCrash(conn: { db: ExecutionService['db'] }, taskId: string, extraCuts = 0) {
  const db = conn.db;
  const last = db.select().from(runs).where(eq(runs.taskId, taskId)).all().filter((r) => r.kind !== 'review').at(-1)!;
  db.update(runs).set({ status: 'running', finishedAt: null }).where(eq(runs.id, last.id)).run();
  db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId)).run();
  const now = new Date().toISOString();
  for (let i = 0; i < extraCuts; i++) {
    db.insert(runs).values({ ...last, id: `cut-${i}`, status: 'stopped', finishedAt: now, failureReason: 'Interrupted by server restart' }).run();
  }
}

describe('restart continuation (B2, R3, after T3 Code)', () => {
  it('continues a task the restart cut short on its branch with the continue prompt', async () => {
    const prompts: string[] = [];
    const { conn, registry, events, project, plan, leadSvc, execSvc } = await setupApprovedProject(makeRunner(prompts));
    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const taskId = plan.tasks[0].id;
      simulateCrash(conn as never, taskId);

      const restarted = new ExecutionService(conn.db, registry, leadSvc, events);
      expect(leadSvc.getPlan(project.id, plan.sessionId)!.tasks[0].status).toBe('stopped');
      await restarted.continueInterruptedWork();
      await restarted.waitForTaskExecution(taskId);

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Continue where you left off');
      expect(prompts[1]).toContain('confirm it did not take effect');
      // The work of the first run is kept: the branch was continued, not reset.
      const task = leadSvc.getPlan(project.id, plan.sessionId)!.tasks[0];
      expect(task.status).toBe('awaiting_merge');
      const notes = leadSvc.getSessionDetail(project.id, plan.sessionId).messages.map((m) => String(m.content));
      expect(notes.some((n) => n.includes(`Continuing [${task.externalId}] after the restart.`))).toBe(true);
      await restarted.approveMergeTask(project.id, taskId, { allowUnconfined: true, runIntegration: false });
    } finally {
      conn.close();
    }
  });

  it('leaves a task stopped after more than three restarts within five minutes', async () => {
    const prompts: string[] = [];
    const { conn, registry, events, project, plan, leadSvc, execSvc } = await setupApprovedProject(makeRunner(prompts));
    try {
      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const taskId = plan.tasks[0].id;
      simulateCrash(conn as never, taskId, 3);

      const restarted = new ExecutionService(conn.db, registry, leadSvc, events);
      await restarted.continueInterruptedWork();
      expect(prompts).toHaveLength(1);
      expect(leadSvc.getPlan(project.id, plan.sessionId)!.tasks[0].status).toBe('stopped');
      const notes = leadSvc.getSessionDetail(project.id, plan.sessionId).messages.map((m) => String(m.content));
      expect(notes.some((n) => n.includes('restarts within five minutes'))).toBe(true);
    } finally {
      conn.close();
    }
  });
});
