import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdapterTurnOptions } from '../adapters/types.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { agentProfiles } from '../db/schema.js';
import { ProfileService } from '../services/profiles.js';
import { cleanupTempDirs, handleLeadCalls, makeTempDir, setupApprovedProject } from './exec-helpers.js';

afterEach(cleanupTempDirs);

type Outcome = 'completed' | 'blocked';

/** Scripted agent: writes a result.json with the chosen status and records how it was invoked. */
function agentRunner(outcome: Outcome, seen: string[] = []): CliRunner {
  return {
    async which(bin) {
      return `/usr/bin/${bin}`;
    },
    async run(cmd, args, opts: RunCommandOptions): Promise<RunCommandResult> {
      const lead = handleLeadCalls(opts.cwd, args, opts);
      if (lead) return lead;
      const joined = `${cmd} ${args.join(' ')}`;
      seen.push(joined);
      const extId = joined.match(/\.dalang\/tasks\/([A-Za-z0-9_-]+)\/result\.json/)?.[1] ?? 'T-001';
      const file = path.join(opts.cwd, '.dalang', 'tasks', extId, 'result.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          task_id: extId,
          status: outcome,
          changed_files: [],
          summary: 'scripted',
          notes: [],
          blockers: outcome === 'blocked' ? ['needs a decision'] : [],
        }),
      );
      const line = JSON.stringify({ type: 'result', session_id: 's-1', result: 'ok' });
      opts.onStdoutLine?.(line);
      return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
    },
  };
}

describe('ExecutionService hardening', () => {
  it('rejects a second start while the first is still preparing, even when requests arrive together', async () => {
    const { conn, project, execSvc } = await setupApprovedProject(agentRunner('completed'));
    try {
      const results = await Promise.allSettled([
        execSvc.startExecution(project.id, { allowUnconfined: true }),
        execSvc.startExecution(project.id, { allowUnconfined: true }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      await execSvc.waitForProjectExecution(project.id);
    } finally {
      conn.close();
    }
  });

  it('does not fall back to another provider when the agent itself reports the task as blocked', async () => {
    const seen: string[] = [];
    const { conn, project, plan, execSvc } = await setupApprovedProject(agentRunner('blocked', seen));
    try {
      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const state = await execSvc.getExecutionState(project.id);
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0]).toMatchObject({ status: 'failed', usedFallback: false });
      expect(state.runs[0].failureReason).toMatch(/needs a decision/);
      expect(seen).toHaveLength(1);
    } finally {
      conn.close();
    }
  });

  it('runs a task on a read-only profile with write access, because it must write result.json', async () => {
    const modes: Array<AdapterTurnOptions['permissionMode']> = [];
    const runner = agentRunner('completed');
    const original = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      // Claude's headless flag for read-only is `plan`; workspace-write must never be downgraded to it.
      modes.push(args.includes('plan') ? 'read-only' : 'workspace-write');
      return original(cmd, args, opts);
    };
    const { conn, project, plan, execSvc } = await setupApprovedProject(runner);
    try {
      const profiles = new ProfileService(conn.db).listProfiles();
      const heavy = profiles.find((p) => p.name === 'coder-heavy')!;
      conn.db.update(agentProfiles).set({ permissionMode: 'read-only' }).where(eq(agentProfiles.id, heavy.id)).run();
      execSvc.assignTaskProfile(project.id, plan.tasks[0].id, heavy.id);

      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      expect((await execSvc.getExecutionState(project.id)).runs[0].status).toBe('completed');
      expect(modes.filter((m) => m === 'read-only')).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('refuses to run git when the repo config defines a clean filter the agent could have planted', async () => {
    const marker = path.join(makeTempDir('dalang-marker-'), 'pwned');
    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(agentRunner('completed'));
    try {
      fs.appendFileSync(path.join(projDir, '.git', 'config'), `\n[filter "pwn"]\n\tclean = touch ${marker}\n`);
      fs.writeFileSync(path.join(projDir, '.gitattributes'), '* filter=pwn\n');
      fs.writeFileSync(path.join(projDir, 'new.txt'), 'x');

      await expect(
        execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true }),
      ).rejects.toThrow(/can run commands/);
      expect(fs.existsSync(marker)).toBe(false);
      await expect(execSvc.getExecutionState(project.id)).resolves.toMatchObject({ activeRun: null });
    } finally {
      conn.close();
    }
  });

  it('refuses a rollback that would discard commits or edits DALANG did not make', async () => {
    const { conn, project, plan, execSvc, projDir } = await setupApprovedProject(agentRunner('completed'));
    try {
      await execSvc.startExecution(project.id, { taskId: plan.tasks[0].id, allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);
      const run = (await execSvc.getExecutionState(project.id)).runs[0];

      fs.writeFileSync(path.join(projDir, 'mine.txt'), 'my uncommitted work');
      await expect(execSvc.rollbackRun(project.id, run.id)).rejects.toThrow(/Uncommitted changes/);

      execFileSync('git', ['add', '-A'], { cwd: projDir });
      execFileSync('git', ['-c', 'user.name=me', '-c', 'user.email=me@x', 'commit', '-m', 'my own commit'], { cwd: projDir });
      await expect(execSvc.rollbackRun(project.id, run.id)).rejects.toThrow(/did not create/);
      expect(fs.existsSync(path.join(projDir, 'mine.txt'))).toBe(true);
    } finally {
      conn.close();
    }
  });
});

describe('routing and scaffold', () => {
  it('uses the first matching rule in order and lets a null complexity match any', async () => {
    const { conn } = await setupApprovedProject(agentRunner('completed'));
    try {
      const svc = new ProfileService(conn.db);
      const low = svc.resolveProfileForTask({ role: 'engineer', complexity: 'low', profileOverride: null });
      const high = svc.resolveProfileForTask({ role: 'engineer', complexity: 'high', profileOverride: null });
      const qa = svc.resolveProfileForTask({ role: 'qa', complexity: 'medium', profileOverride: null });
      expect(low.primary.name).toBe('coder-small');
      expect(high.primary.name).toBe('coder-heavy');
      expect(qa.primary.name).toBe('reviewer');
      expect(low.source).toBe('routing_rule');
    } finally {
      conn.close();
    }
  });

  it('gives a new project a root .gitignore so a checkpoint never commits dependencies or secrets', async () => {
    const { conn, projDir } = await setupApprovedProject(agentRunner('completed'));
    try {
      const ignore = fs.readFileSync(path.join(projDir, '.gitignore'), 'utf8');
      expect(ignore).toMatch(/node_modules\//);
      expect(ignore).toMatch(/\.env/);
    } finally {
      conn.close();
    }
  });
});
