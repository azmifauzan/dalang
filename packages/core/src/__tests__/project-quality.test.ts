import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomReportContent } from '@dalang/shared';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { imagePathsInText } from '../services/references.js';
import { proposeProjectCheck } from '../services/workspace-setup.js';
import { cleanupTempDirs, handleLeadCalls, makeTempDir, setupApprovedProject, shellCommand } from './exec-helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('project check and references (B31 to B33)', () => {
  it('proposes the command that already guards the project', () => {
    const dir = makeTempDir('dalang-check-');
    expect(proposeProjectCheck(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(proposeProjectCheck(dir)).toBe('pnpm run typecheck && pnpm run test');
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ scripts: { 'ci:check': ['@test'] } }));
    expect(proposeProjectCheck(dir)).toBe('composer ci:check');
  });

  it('finds image files a message names by path', () => {
    const dir = makeTempDir('dalang-ref-');
    const spaced = path.join(dir, 'my shot.png');
    const plain = path.join(dir, 'reference-2.jpeg');
    for (const file of [spaced, plain]) fs.writeFileSync(file, 'x');
    expect(imagePathsInText(`'${spaced}' see ${plain} and /nope/missing.png and notes.png`).sort()).toEqual([plain, spaced].sort());
  });

  it('runs the project check with each task, shows what the reviewer did not check, and commits nothing of .dalang', async () => {
    const shellCommands: string[] = [];
    const prompts = { coder: [] as string[], review: [] as string[] };
    let checkPasses = false;
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        const shell = shellCommand(cmd, args);
        if (shell !== null) {
          shellCommands.push(shell);
          if (shell.includes('project-ci') && !checkPasses) return { ...ok, exitCode: 1, stdout: 'format error in 11 files\n' };
          return ok;
        }
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const prompt = args.join(' ');
        const reviewed = prompt.match(/code review round \d+ of \d+ for task ([A-Za-z0-9_.-]+)/i);
        if (reviewed) {
          prompts.review.push(prompt);
          const failed = !checkPasses;
          checkPasses = true;
          const payload = JSON.stringify({
            task_id: reviewed[1], status: failed ? 'fail' : 'pass', verify_exit_code: failed ? 1 : 0, summary: 'Reviewed',
            findings: failed ? [{ severity: 'major', file: 'src/a.ts', note: 'The project check fails' }] : [],
            unverified: failed ? [] : ['How the card looks on a wide screen'],
          });
          const line = JSON.stringify(prompt.includes('codex') ? { type: 'item.completed', item: { type: 'agent_message', text: payload } } : { type: 'result', session_id: 'r', result: payload });
          opts.onStdoutLine?.(line);
          return { ...ok, stdout: `${line}\n` };
        }
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (!match) return ok;
        prompts.coder.push(prompt);
        fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, 'src', 'a.ts'), `export const pass = ${prompts.coder.length};\n`);
        // A file planted in another task's folder must not be copied into the project.
        const planted = path.join(opts.cwd, path.dirname(path.dirname(match[1])), 'T-999', 'review.json');
        fs.mkdirSync(path.dirname(planted), { recursive: true });
        fs.writeFileSync(planted, '{"status":"pass"}');
        // Nor one under another session that has a task with this same id, nor an unexpected file here.
        for (const stray of [`.dalang/sessions/other-session/tasks/${match[2]}/review.json`, `${path.dirname(match[1])}/notes.sh`, `.dalang/tasks/${match[2]}/review.json`]) {
          fs.mkdirSync(path.dirname(path.join(opts.cwd, stray)), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, stray), '{"status":"pass"}');
        }
        fs.mkdirSync(path.dirname(path.join(opts.cwd, match[1])), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, match[1]), JSON.stringify({ task_id: match[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }));
        return ok;
      },
    };
    const { conn, project, plan, execSvc, leadSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'Card', complexity: 'medium', files_allowed: ['src/**'] },
    ]);
    try {
      const shot = path.join(makeTempDir('dalang-ref-'), 'reference.jpeg');
      fs.writeFileSync(shot, 'x');
      conn.sqlite
        .prepare("INSERT INTO messages (id, session_id, role, type, content, created_at) VALUES ('ref', ?, 'user', 'text', ?, ?)")
        .run(plan.sessionId, `Match '${shot}'`, new Date().toISOString());
      await execSvc.setWorkspaceSetup(project.id, { command: null, maintenanceCommand: null, checkCommand: 'project-ci', files: [] });

      await execSvc.startExecution(project.id, { allowUnconfined: true });
      await execSvc.waitForProjectExecution(project.id);

      // B32: the task's own verify and the project check ran as one command, and its failure reached the fix round.
      expect(shellCommands.some((c) => c.includes('(pnpm test) && (project-ci)'))).toBe(true);
      expect(prompts.coder[0]).toContain("the project's own check, which must pass: project-ci");
      expect(prompts.coder[1]).toContain('format error in 11 files');
      expect(prompts.coder[1]).toContain('(pnpm test) && (project-ci)');
      // B33: both sides are told about the user's reference image.
      expect(prompts.coder[0]).toContain(shot);
      expect(prompts.review[0]).toContain(shot);
      const reports = () => leadSvc.getSessionDetail(project.id, plan.sessionId).messages.filter((m) => m.type === 'report').map((m) => m.content as RoomReportContent);
      const verdict = reports().filter((r) => r.event === 'review_verdict').at(-1)!;
      expect(verdict.unverified).toEqual(['How the card looks on a wide screen']);
      expect(verdict.summary).toContain('Not checked by the reviewer');

      const taskId = plan.tasks[0].id;
      await execSvc.approveMergeTask(project.id, taskId, { allowUnconfined: true });
      // B31: nothing of DALANG's reaches the user's history, and the review stays readable.
      expect(git(projDir, 'log', '--name-only', '--format=', 'main')).not.toMatch(/\.dalang\//);
      expect(git(projDir, 'status', '--porcelain')).not.toMatch(/\.dalang/);
      expect(fs.existsSync(path.join(projDir, '.dalang', 'sessions', plan.sessionId, 'tasks', 'T-999'))).toBe(false);
      for (const stray of ['sessions/other-session/tasks/T-001/review.json', `sessions/${plan.sessionId}/tasks/T-001/notes.sh`, 'tasks/T-001/review.json']) {
        expect(fs.existsSync(path.join(projDir, '.dalang', stray)), stray).toBe(false);
      }
      const guard = await execSvc.getGuardState(project.id);
      expect(guard.tasks[0].latestReview?.contract.unverified).toEqual(['How the card looks on a wide screen']);
      expect(reports().some((r) => r.event === 'integration_result' && r.summary.includes('Integration check passed') && r.summary.includes('project-ci'))).toBe(true);
    } finally {
      conn.close();
    }
  });
});
