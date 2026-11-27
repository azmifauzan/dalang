import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomReportContent } from '@dalang/shared';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { copyApprovedFiles, proposeWorkspaceSetup } from '../services/workspace-setup.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  makeTempDir,
  setupApprovedProject,
  shellCommand,
} from './exec-helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

function repo(files: Record<string, string>): string {
  const dir = makeTempDir('dalang-setup-');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init', '--allow-empty');
  return dir;
}

describe('worktree setup proposal (U11)', () => {
  it('has nothing to ask for a plain JavaScript project', async () => {
    const dir = repo({ 'package.json': '{"name":"a"}', 'package-lock.json': '{}' });
    expect(await proposeWorkspaceSetup(dir)).toBeNull();
  });

  it('prefers what the repository declares, then the Lead, then the lockfiles', async () => {
    const dir = repo({ 'composer.lock': '{}', 'package.json': '{"name":"a"}', 'package-lock.json': '{}' });
    // The user's own checkout is installed already; the proposal is for a fresh worktree.
    fs.mkdirSync(path.join(dir, 'node_modules'));
    const guessed = await proposeWorkspaceSetup(dir);
    expect(guessed?.command).toBe('composer install --no-interaction --prefer-dist && npm ci --no-audit --no-fund');
    // After a snapshot, `npm ci` is left out: it would delete the restored node_modules.
    expect(guessed?.maintenanceCommand).toBe('composer install --no-interaction --prefer-dist');
    expect((await proposeWorkspaceSetup(dir, 'make setup'))?.command).toBe('make setup');
    write(dir, 't3.json', JSON.stringify({ scripts: [{ command: 'just bootstrap', runOnWorktreeCreate: true }, { command: 'just dev' }] }));
    expect(await proposeWorkspaceSetup(dir, 'make setup')).toMatchObject({ command: 'just bootstrap', source: 't3.json' });
  });

  it('offers only ignored files from .worktreeinclude and warns about secrets and databases', async () => {
    const dir = repo({ '.gitignore': '.env\nlocal/\n', '.worktreeinclude': '.env\nlocal/dev.json\ntracked.txt\n', 'tracked.txt': 't' });
    write(dir, '.env', 'DB_HOST=db.internal\n');
    write(dir, 'local/dev.json', '{}');
    const proposal = await proposeWorkspaceSetup(dir);
    expect(proposal?.files).toEqual(['.env', 'local/dev.json']);
    expect(proposal?.warnings.join(' ')).toMatch(/may hold secrets/);
    expect(proposal?.warnings.join(' ')).toMatch(/names a database/);
  });

  it('copies only safe ignored files into a worktree', async () => {
    const outside = makeTempDir('dalang-setup-outside-');
    write(outside, 'secret.txt', 'outside');
    const main = repo({ '.gitignore': '.env\nlink.txt\nlinked/\n', 'tracked.txt': 't' });
    write(main, '.env', 'A=1\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(main, 'link.txt'));
    const wt = path.join(makeTempDir('dalang-setup-wt-'), 'wt');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'task');
    // A link the task left behind must not lead a copy outside the worktree.
    fs.symlinkSync(outside, path.join(wt, 'linked'));
    write(main, 'linked/new.txt', 'x');
    const copied = await copyApprovedFiles(main, wt, ['.env', 'link.txt', 'tracked.txt', '../x', '/etc/hosts', '.git/config', 'linked/new.txt']);
    expect(copied).toEqual(['.env']);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});

describe('worktree setup in a run (U11)', () => {
  it('runs the approved command, saves a snapshot, restores it for the next task, and reports a failure', async () => {
    const setupRuns: Array<{ cwd: string; hadVendor: boolean; command: string }> = [];
    const prompts: string[] = [];
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(cmd, args, opts): Promise<RunCommandResult> {
        const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
        const shell = shellCommand(cmd, args);
        if (shell?.includes('fake-setup')) {
          setupRuns.push({ cwd: opts.cwd, hadVendor: fs.existsSync(path.join(opts.cwd, 'vendor', 'lib.txt')), command: shell });
          if (shell.includes('fake-setup-broken')) {
            opts.onStderrLine?.('composer: not found');
            return { ...ok, exitCode: 127 };
          }
          write(opts.cwd, 'vendor/lib.txt', 'installed');
          write(opts.cwd, '.env.local', 'GENERATED=1');
          return ok;
        }
        const lead = handleLeadCalls(opts.cwd, args, opts);
        if (lead) return lead;
        const review = handleVerifyAndReviewCalls(cmd, args, opts, 'pass');
        if (review) return review;
        const prompt = args.join(' ');
        const match = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_-]+)\/result\.json)/);
        if (!match) return ok;
        prompts.push(prompt);
        write(opts.cwd, `src/${match[2]}.ts`, 'export {};\n');
        write(opts.cwd, match[1], JSON.stringify({ task_id: match[2], status: 'completed', summary: 'Done', notes: [], blockers: [], verify_exit_code: 0 }));
        return ok;
      },
    };
    const { conn, project, plan, execSvc, leadSvc, projDir } = await setupApprovedProject(runner, [
      { id: 'T-001', title: 'First', files_allowed: ['src/**'] },
      { id: 'T-002', title: 'Second', depends_on: ['T-001'], files_allowed: ['src/**'] },
      { id: 'T-003', title: 'Third', depends_on: ['T-002'], files_allowed: ['src/**'] },
    ]);
    try {
      fs.appendFileSync(path.join(projDir, '.gitignore'), '\nvendor/\n.env\n.env.local\n');
      write(projDir, 'composer.lock', '{}');
      git(projDir, 'add', '.gitignore', 'composer.lock');
      git(projDir, 'commit', '-qm', 'ignore');
      write(projDir, '.env', 'A=1\n');

      expect((await execSvc.getWorkspaceSetup(project.id)).needsApproval).toBe(true);
      await expect(execSvc.setWorkspaceSetup(project.id, { command: 'x', maintenanceCommand: null, files: ['../x'] })).rejects.toThrow(/Not a file inside/);
      await execSvc.setWorkspaceSetup(project.id, { command: 'fake-setup', maintenanceCommand: null, files: ['.env'] });

      const runTask = async (index: number) => {
        const taskId = plan.tasks[index].id;
        await execSvc.startExecution(project.id, { taskId, allowUnconfined: true });
        await execSvc.waitForTaskExecution(taskId);
        await execSvc.approveMergeTask(project.id, taskId, { allowUnconfined: true, runIntegration: false });
      };
      const reports = () =>
        leadSvc.getSessionDetail(project.id, plan.sessionId).messages
          .filter((m) => m.type === 'report')
          .map((m) => m.content as RoomReportContent)
          .filter((c) => c.event === 'setup_result')
          .map((c) => c.summary);

      await runTask(0);
      expect(setupRuns[0]).toMatchObject({ hadVendor: false });
      expect(prompts[0]).toContain("already prepared this worktree with the project's setup command (fake-setup) and copied .env");
      expect(reports()[0]).toMatch(/Worktree ready in \d+s\. Saved a snapshot/);
      expect((await execSvc.getWorkspaceSetup(project.id)).hasSnapshot).toBe(true);
      // Local settings are never kept in a snapshot.
      const snapshots = path.join(path.dirname((execSvc as unknown as { worktreesRoot: string }).worktreesRoot), 'snapshots', project.id);
      const kept = fs.readdirSync(path.join(snapshots, fs.readdirSync(snapshots)[0], 'files'));
      expect(kept).toContain('vendor');
      expect(kept.filter((name) => name.startsWith('.env'))).toEqual([]);

      await runTask(1);
      expect(setupRuns[1]).toMatchObject({ hadVendor: true });
      expect(reports()[1]).toContain('from the snapshot');

      await execSvc.setWorkspaceSetup(project.id, { command: 'fake-setup-broken', maintenanceCommand: null, files: [] });
      await runTask(2);
      expect(reports()[2]).toContain('Worktree setup failed');
      expect(reports()[2]).toContain('composer: not found');
      expect(prompts[2]).toContain('it failed');

      await execSvc.resetWorkspaceSnapshot(project.id);
      expect((await execSvc.getWorkspaceSetup(project.id)).hasSnapshot).toBe(false);
    } finally {
      conn.close();
    }
  });
});
