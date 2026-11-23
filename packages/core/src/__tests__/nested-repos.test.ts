import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../adapters/registry.js';
import { buildMacOsSeatbeltProfile, wrapWithBwrap } from '../adapters/sandbox.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { openDatabase } from '../db/client.js';
import { runRepoCheckpoints, taskRepos } from '../db/schema.js';
import { DalangEventBus } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import {
  branchExists,
  findNestedRepos,
  getHeadCommit,
  listGitWorktrees,
  listHiddenCheckpointRefs,
} from '../services/git.js';
import { LeadService } from '../services/lead.js';
import { ProfileService } from '../services/profiles.js';
import { ProjectService } from '../services/project.js';
import { SettingsService } from '../services/settings.js';
import {
  cleanupTempDirs,
  handleLeadCalls,
  handleVerifyAndReviewCalls,
  makeTempDir,
} from './exec-helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@local',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@local',
    },
  }).trim();
}

function initRepo(dir: string, branch: string, files: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', branch);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `init ${path.basename(dir)}`);
  return git(dir, 'rev-parse', 'HEAD');
}

function createWorkspaceFixture(): {
  rootDir: string;
  frontendDir: string;
  backendDir: string;
  schedDir: string;
  initialShas: Record<string, string>;
} {
  const rootDir = path.join(makeTempDir('dalang-ws-'), 'sei-office-fixture');
  const rootSha = initRepo(rootDir, 'dev', {
    '.gitignore': 'frontend/\nbackend/\nscheduling-service/\n',
    'README.md': '# Workspace\n',
  });
  const frontendDir = path.join(rootDir, 'frontend');
  const frontendSha = initRepo(frontendDir, 'dev', {
    'src/app.ts': 'export const greeting = "hello";\n',
    'src/other.ts': 'export const other = 1;\n',
  });
  const backendDir = path.join(rootDir, 'backend');
  const backendSha = initRepo(backendDir, 'dev', {
    'src/api.ts': 'export const api = "v1";\n',
  });
  const schedDir = path.join(rootDir, 'scheduling-service');
  const schedSha = initRepo(schedDir, 'feat/employee-sync', {
    'src/job.ts': 'export const interval = 60;\n',
  });

  return {
    rootDir,
    frontendDir,
    backendDir,
    schedDir,
    initialShas: {
      '.': rootSha,
      frontend: frontendSha,
      backend: backendSha,
      'scheduling-service': schedSha,
    },
  };
}

async function setupWorkspaceHarness(opts: {
  rootDir: string;
  filesAllowed: string[];
  onCoder: (args: string[], runOpts: RunCommandOptions, execSvc: ExecutionService) => Promise<RunCommandResult | null>;
  onReviewPrompt?: (prompt: string) => void;
  onGhPr?: (args: string[], runOpts: RunCommandOptions) => RunCommandResult;
}) {
  const dbDir = makeTempDir('dalang-ws-db-');
  const conn = openDatabase(path.join(dbDir, 'dalang.db'));
  if (process.platform === 'win32') {
    new ProfileService(conn.db).updateProfile('profile-reviewer', { provider: 'codex', model: '' });
  }
  const events = new DalangEventBus();
  const settingsSvc = new SettingsService(conn.db);
  let execSvcRef: ExecutionService | null = null;

  const runner: CliRunner = {
    async which(bin) {
      if (bin === 'bwrap' || bin === 'sandbox-exec') return null;
      return `/usr/local/bin/${bin}`;
    },
    async run(cmd, args, runOpts): Promise<RunCommandResult> {
      if (path.basename(cmd) === 'gh' && opts.onGhPr) {
        return opts.onGhPr(args, runOpts);
      }
      const leadReply = handleLeadCalls(runOpts.cwd, args, runOpts);
      if (leadReply) return leadReply;

      const joined = `${cmd} ${args.join(' ')}`;
      if (/code review round \d+ of \d+ for task/i.test(joined)) {
        opts.onReviewPrompt?.(joined);
        const rev = handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
        if (rev) return rev;
      }

      const coderReply = await opts.onCoder(args, runOpts, execSvcRef!);
      if (coderReply) return coderReply;

      const verifyOrRev = handleVerifyAndReviewCalls(cmd, args, runOpts, 'pass');
      if (verifyOrRev) return verifyOrRev;

      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
    },
  };

  const registry = new ProviderRegistry(runner, {
    antigravityKeyringAccess: () => settingsSvc.antigravityKeyringAccess(),
  });
  const projectSvc = new ProjectService(conn.db);
  const leadSvc = new LeadService(conn.db, registry, events);
  const execSvc = new ExecutionService(conn.db, registry, leadSvc, events);
  execSvcRef = execSvc;

  const project = await projectSvc.createOrOpen({
    mode: 'open',
    name: 'Workspace',
    path: opts.rootDir,
    initGitIfMissing: false,
    leadProvider: 'claude-code',
  });
  // Commit scaffold files (PROJECT.md / .dalang/.gitignore) so baseline is clean before tests add dirty files.
  git(opts.rootDir, 'add', '-A');
  const statusAfterScaffold = git(opts.rootDir, 'status', '--porcelain');
  if (statusAfterScaffold) {
    git(opts.rootDir, 'commit', '-m', 'chore: scaffold');
  }

  await leadSvc.finishDiscussAndWriteBrief(project.id);
  const briefs = leadSvc.listBriefs(project.id);
  leadSvc.approveBrief(project.id, briefs[0].version);
  const draftPlan = await leadSvc.generatePlan(project.id);
  const taskId = draftPlan.tasks[0].id;
  leadSvc.updateTask(project.id, taskId, {
    filesAllowed: opts.filesAllowed,
    verify: 'echo ok',
  });
  const plan = leadSvc.approvePlan(project.id);

  return { conn, project, plan, task: plan.tasks[0], leadSvc, execSvc, projectSvc };
}

function writeResultFromPrompt(cwd: string, prompt: string, changedFiles: string[]): void {
  const m = prompt.match(/(\.dalang\/(?:sessions\/[A-Za-z0-9_-]+\/)?tasks\/([A-Za-z0-9_.-]+)\/result\.json)/);
  if (!m) return;
  const target = path.join(cwd, m[1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      task_id: m[2],
      status: 'completed',
      changed_files: changedFiles,
      summary: `Updated ${changedFiles.join(', ')}`,
      notes: [],
      blockers: [],
      verify_command: 'echo ok',
      verify_exit_code: 0,
    }),
  );
}

afterEach(() => {
  cleanupTempDirs();
});

describe('v0.9 workspace projects with nested repositories', () => {
  it('lists top-level standalone repos and excludes submodules, nested-below-top-level, and .dalang', () => {
    const dir = makeTempDir('dalang-nested-');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.dalang', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'frontend', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'backend', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs', 'deep', '.git'), { recursive: true });
    // Git submodule has a `.git` file, not a directory.
    fs.mkdirSync(path.join(dir, 'submod'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'submod', '.git'), 'gitdir: ../.git/modules/submod\n');
    expect(findNestedRepos(dir)).toEqual(['backend', 'frontend']);
  });

  it('mounts root and nested worktree .git link files read-only in Linux bwrap and macOS Seatbelt', async () => {
    const wt = makeTempDir('dalang-sb-wt-');
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /tmp/main/.git/worktrees/T-001\n');
    fs.mkdirSync(path.join(wt, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'frontend', '.git'), 'gitdir: /tmp/main/frontend/.git/worktrees/T-001\n');
    fs.mkdirSync(path.join(wt, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'backend', '.git'), 'gitdir: /tmp/main/backend/.git/worktrees/T-001\n');

    const fakeRunner: CliRunner = {
      async which(bin) {
        return bin === 'bwrap' ? '/usr/bin/bwrap' : null;
      },
      async run() {
        throw new Error('not run');
      },
    };

    const bwrap = await wrapWithBwrap(fakeRunner, 'codex', wt, '/usr/bin/codex', ['exec'], {
      platform: 'linux',
      bindProviderDirs: false,
    });
    expect(bwrap.sandboxed).toBe(true);
    const roIdxRoot = bwrap.args.indexOf(path.join(wt, '.git'));
    const roIdxFe = bwrap.args.indexOf(path.join(wt, 'frontend', '.git'));
    const roIdxBe = bwrap.args.indexOf(path.join(wt, 'backend', '.git'));
    expect(roIdxRoot).toBeGreaterThan(0);
    expect(bwrap.args[roIdxRoot - 1]).toBe('--ro-bind');
    expect(roIdxFe).toBeGreaterThan(0);
    expect(bwrap.args[roIdxFe - 1]).toBe('--ro-bind');
    expect(roIdxBe).toBeGreaterThan(0);
    expect(bwrap.args[roIdxBe - 1]).toBe('--ro-bind');

    const sbpl = buildMacOsSeatbeltProfile('codex', wt, { bindProviderDirs: false });
    expect(sbpl).toContain(`(deny file-write* (literal "${path.join(wt, '.git')}"))`);
    expect(sbpl).toContain(`(deny file-write* (literal "${path.join(wt, 'frontend', '.git')}"))`);
    expect(sbpl).toContain(`(deny file-write* (literal "${path.join(wt, 'backend', '.git')}"))`);
  });

  it('runs a multi-repo task end-to-end with per-repo checkpoints, joined diff, dirty-unrelated merge, and cleanup', async () => {
    const ws = createWorkspaceFixture();
    // Unrelated uncommitted files in root and frontend must survive task start and Gate 2 merge.
    fs.writeFileSync(path.join(ws.rootDir, 'scratch-root.txt'), 'keep me root\n');
    fs.writeFileSync(path.join(ws.frontendDir, 'src/other.ts'), 'export const other = 999; // dirty\n');

    let capturedReviewPrompt = '';
    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/app.ts', 'scheduling-service/src/job.ts'],
      onReviewPrompt: (p) => {
        capturedReviewPrompt = p;
      },
      onCoder: async (args, runOpts) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;
        fs.writeFileSync(
          path.join(runOpts.cwd, 'frontend/src/app.ts'),
          'export const greeting = "hello v0.9";\n',
        );
        fs.writeFileSync(
          path.join(runOpts.cwd, 'scheduling-service/src/job.ts'),
          'export const interval = 30;\n',
        );
        writeResultFromPrompt(runOpts.cwd, prompt, [
          'frontend/src/app.ts',
          'scheduling-service/src/job.ts',
        ]);
        const line = JSON.stringify({ type: 'result', session_id: 'coder-ws-1', result: 'Done' });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);

      // Verify task_repos persisted all 4 repos with their respective checked-out base branches.
      const repoRows = harness.conn.db
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, harness.task.id))
        .all();
      expect(repoRows.map((r) => r.repoPath).sort()).toEqual([
        '.',
        'backend',
        'frontend',
        'scheduling-service',
      ]);
      expect(repoRows.find((r) => r.repoPath === 'scheduling-service')?.baseBranch).toBe('feat/employee-sync');
      expect(repoRows.find((r) => r.repoPath === 'frontend')?.baseBranch).toBe('dev');

      // Verify per-repo run_repo_checkpoints and hidden refs exist in nested repos.
      const cpRows = harness.conn.db.select().from(runRepoCheckpoints).all();
      expect(cpRows.some((c) => c.repoPath === 'frontend' && Boolean(c.commitAfter))).toBe(true);
      expect(cpRows.some((c) => c.repoPath === 'scheduling-service' && Boolean(c.commitAfter))).toBe(true);
      expect((await listHiddenCheckpointRefs(ws.frontendDir)).length).toBeGreaterThan(0);

      // Verify reviewer saw joined diff with repo labels and root-relative paths.
      expect(capturedReviewPrompt).toContain('=== Repository: frontend/ [base: dev] ===');
      expect(capturedReviewPrompt).toContain('=== Repository: scheduling-service/ [base: feat/employee-sync] ===');
      expect(capturedReviewPrompt).toContain('frontend/src/app.ts');
      expect(capturedReviewPrompt).toContain('scheduling-service/src/job.ts');

      // Verify getTaskDiffForTask returns labeled files and repo summaries.
      const diff = await harness.execSvc.getTaskDiffForTask(harness.project.id, harness.task.id);
      expect(diff.files.map((f) => f.path)).toEqual(
        expect.arrayContaining(['frontend/src/app.ts', 'scheduling-service/src/job.ts']),
      );
      expect(diff.files.find((f) => f.path === 'frontend/src/app.ts')?.repo).toBe('frontend');
      expect(diff.files.find((f) => f.path === 'scheduling-service/src/job.ts')?.repo).toBe(
        'scheduling-service',
      );
      expect(diff.repos?.find((r) => r.repoPath === 'scheduling-service')?.baseBranch).toBe(
        'feat/employee-sync',
      );

      // Gate 2 merge: succeeds despite unrelated dirty files in root and frontend.
      const backendHeadBefore = await getHeadCommit(ws.backendDir);
      const mergeRes = await harness.execSvc.approveMergeTask(harness.project.id, harness.task.id, {
        runIntegration: false,
      });
      expect(mergeRes.task.status).toBe('done');

      // Changed nested repos merged into their checked-out branches; untouched backend has NO new commit.
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/app.ts'), 'utf8')).toContain('hello v0.9');
      expect(fs.readFileSync(path.join(ws.schedDir, 'src/job.ts'), 'utf8')).toContain('interval = 30');
      expect(await getHeadCommit(ws.backendDir)).toBe(backendHeadBefore);

      // Unrelated uncommitted work stays intact.
      expect(fs.readFileSync(path.join(ws.rootDir, 'scratch-root.txt'), 'utf8')).toBe('keep me root\n');
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/other.ts'), 'utf8')).toContain('other = 999');

      // All worktrees and dalang/T-001 branches removed across every repo.
      for (const dir of [ws.rootDir, ws.frontendDir, ws.backendDir, ws.schedDir]) {
        expect(await listGitWorktrees(dir)).toHaveLength(1);
        expect(await branchExists(dir, 'dalang/T-001')).toBe(false);
      }

      // Post-merge diff still works using per-repo mergeCommitSha.
      const postMergeDiff = await harness.execSvc.getTaskDiffForTask(harness.project.id, harness.task.id);
      expect(postMergeDiff.files.map((f) => f.path)).toEqual(
        expect.arrayContaining(['frontend/src/app.ts', 'scheduling-service/src/job.ts']),
      );
    } finally {
      harness.conn.close();
    }
  });

  it('catches out-of-scope edits inside a nested repo during scope check', async () => {
    const ws = createWorkspaceFixture();
    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/app.ts'],
      onCoder: async (args, runOpts) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;
        fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/app.ts'), 'export const greeting = "ok";\n');
        // Out-of-scope edit in backend/
        fs.writeFileSync(path.join(runOpts.cwd, 'backend/src/api.ts'), 'export const api = "leaked";\n');
        writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/app.ts', 'backend/src/api.ts']);
        const line = JSON.stringify({ type: 'result', session_id: 'coder-scope', result: 'Done' });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);

      const guard = await harness.execSvc.getGuardState(harness.project.id);
      const entry = guard.tasks.find((t) => t.task.id === harness.task.id)!;
      // Scope violation forces review failure even though reviewer returned pass.
      expect(entry.task.status).toBe('review_failed');
      expect(entry.latestReview?.scopeWarnings.some((w) => w.includes('backend/src/api.ts'))).toBe(true);
    } finally {
      harness.conn.close();
    }
  });

  it('refuses merge on dirty overlap and rolls back earlier merged repos with git reset --keep when a later repo conflicts', async () => {
    const ws = createWorkspaceFixture();
    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/app.ts', 'scheduling-service/src/job.ts'],
      onCoder: async (args, runOpts) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;
        fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/app.ts'), 'export const greeting = "task edit";\n');
        fs.writeFileSync(path.join(runOpts.cwd, 'scheduling-service/src/job.ts'), 'export const interval = 10;\n');
        writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/app.ts', 'scheduling-service/src/job.ts']);
        const line = JSON.stringify({ type: 'result', session_id: 'coder-conflict', result: 'Done' });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);

      // 1. Overlapping uncommitted edit in frontend/src/app.ts refuses merge before touching any repo.
      fs.writeFileSync(path.join(ws.frontendDir, 'src/app.ts'), 'export const greeting = "local dirty";\n');
      await expect(
        harness.execSvc.approveMergeTask(harness.project.id, harness.task.id, { runIntegration: false }),
      ).rejects.toThrow(/uncommitted changes overlap.*src\/app\.ts/);

      // Restore overlapping file, keep an unrelated uncommitted file in frontend/src/other.ts.
      git(ws.frontendDir, 'checkout', '--', 'src/app.ts');
      fs.writeFileSync(path.join(ws.frontendDir, 'src/other.ts'), 'export const other = 777; // keep!\n');

      // 2. Introduce a conflicting commit on scheduling-service's base branch so repo #2 fails mid-merge.
      fs.writeFileSync(path.join(ws.schedDir, 'src/job.ts'), 'export const interval = 9999;\n');
      git(ws.schedDir, 'add', 'src/job.ts');
      git(ws.schedDir, 'commit', '-m', 'conflicting edit on feat/employee-sync');

      const frontendHeadBefore = await getHeadCommit(ws.frontendDir);
      const rootHeadBefore = await getHeadCommit(ws.rootDir);

      await expect(
        harness.execSvc.approveMergeTask(harness.project.id, harness.task.id, { runIntegration: false }),
      ).rejects.toThrow(/rolled back with git reset --keep/i);

      // Earlier merged repos (root and frontend) returned to pre-merge commit and frontend's unrelated dirty edit survived.
      expect(await getHeadCommit(ws.frontendDir)).toBe(frontendHeadBefore);
      expect(await getHeadCommit(ws.rootDir)).toBe(rootHeadBefore);
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/other.ts'), 'utf8')).toContain('other = 777');
      // Branches still exist so the user can resolve and retry.
      expect(await branchExists(ws.frontendDir, 'dalang/T-001')).toBe(true);
    } finally {
      harness.conn.close();
    }
  });

  it('pushes and opens pull requests per changed repo remote', async () => {
    const ws = createWorkspaceFixture();
    // Create bare local remotes for root, frontend, and scheduling-service.
    const remotesDir = makeTempDir('dalang-remotes-');
    for (const [name, repoDir] of [
      ['root', ws.rootDir],
      ['frontend', ws.frontendDir],
      ['sched', ws.schedDir],
    ] as const) {
      const bare = path.join(remotesDir, `${name}.git`);
      fs.mkdirSync(bare, { recursive: true });
      git(bare, 'init', '--bare');
      git(repoDir, 'remote', 'add', 'origin', bare);
    }

    const ghCalls: Array<{ cwd: string; args: string[] }> = [];
    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/app.ts', 'scheduling-service/src/job.ts'],
      onGhPr: (args, runOpts) => {
        ghCalls.push({ cwd: runOpts.cwd, args });
        const repoName = path.basename(runOpts.cwd);
        return {
          exitCode: 0,
          stdout: `https://github.com/example/${repoName}/pull/42\n`,
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      },
      onCoder: async (args, runOpts) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;
        fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/app.ts'), 'export const greeting = "pushed";\n');
        fs.writeFileSync(path.join(runOpts.cwd, 'scheduling-service/src/job.ts'), 'export const interval = 15;\n');
        writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/app.ts', 'scheduling-service/src/job.ts']);
        const line = JSON.stringify({ type: 'result', session_id: 'coder-push', result: 'Done' });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);
      await harness.execSvc.approveMergeTask(harness.project.id, harness.task.id, { runIntegration: false });

      const pushRes = await harness.execSvc.pushTaskBranchAndPr(harness.project.id, harness.task.id, {
        createPr: false,
      });
      expect(pushRes.pushed).toBe(true);
      expect(pushRes.repos?.map((r) => r.repoPath)).toEqual(
        expect.arrayContaining(['frontend', 'scheduling-service']),
      );
      expect(git(path.join(remotesDir, 'frontend.git'), 'rev-parse', 'refs/heads/dev')).toBe(
        await getHeadCommit(ws.frontendDir),
      );
      expect(git(path.join(remotesDir, 'sched.git'), 'rev-parse', 'refs/heads/feat/employee-sync')).toBe(
        await getHeadCommit(ws.schedDir),
      );

      const prRes = await harness.execSvc.pushTaskBranchAndPr(harness.project.id, harness.task.id, {
        createPr: true,
      });
      expect(prRes.pushed).toBe(true);
      expect(ghCalls.some((c) => c.cwd === ws.frontendDir && c.args.includes('dev'))).toBe(true);
      expect(ghCalls.some((c) => c.cwd === ws.schedDir && c.args.includes('feat/employee-sync'))).toBe(true);

      const storedRepos = harness.conn.db
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, harness.task.id))
        .all();
      expect(storedRepos.find((r) => r.repoPath === 'frontend')?.prUrl).toContain('/frontend/pull/42');
      expect(storedRepos.find((r) => r.repoPath === 'scheduling-service')?.prUrl).toContain(
        '/scheduling-service/pull/42',
      );
    } finally {
      harness.conn.close();
    }
  });

  it('rolls back merged changes across every affected repo and refuses when a nested repo is dirty', async () => {
    const ws = createWorkspaceFixture();
    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/app.ts'],
      onCoder: async (args, runOpts) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;
        fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/app.ts'), 'export const greeting = "to-rollback";\n');
        writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/app.ts']);
        const line = JSON.stringify({ type: 'result', session_id: 'coder-rb', result: 'Done' });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      const rootBefore = await getHeadCommit(ws.rootDir);
      const feBefore = await getHeadCommit(ws.frontendDir);

      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);
      await harness.execSvc.approveMergeTask(harness.project.id, harness.task.id, { runIntegration: false });

      const execState = await harness.execSvc.getExecutionState(harness.project.id);
      const executeRun = execState.runs.find((r) => r.kind === 'execute')!;

      // Dirty nested repo refuses rollback.
      fs.writeFileSync(path.join(ws.frontendDir, 'src/other.ts'), 'dirty');
      await expect(harness.execSvc.rollbackRun(harness.project.id, executeRun.id)).rejects.toThrow(
        /Uncommitted changes.*frontend/,
      );
      git(ws.frontendDir, 'checkout', '--', 'src/other.ts');

      // Clean rollback resets both root and frontend to pre-run commits.
      const rolled = await harness.execSvc.rollbackRun(harness.project.id, executeRun.id);
      expect(rolled.status).toBe('rolled_back');
      expect(await getHeadCommit(ws.rootDir)).toBe(rootBefore);
      expect(await getHeadCommit(ws.frontendDir)).toBe(feBefore);
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/app.ts'), 'utf8')).toContain('"hello"');
    } finally {
      harness.conn.close();
    }
  });

  it('delegates a subtask with nested worktrees branched from the parent and merges back per repo', async () => {
    const ws = createWorkspaceFixture();
    let delegatedCalled = false;

    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/**'],
      onCoder: async (args, runOpts, execSvc) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;

        // Parent task T-001 delegates subtask T-001.1 via MCP.
        if (prompt.includes('T-001/result.json') && !delegatedCalled) {
          delegatedCalled = true;
          const activeTokens = [...(execSvc.getDelegationStore() as unknown as { scopes: Map<string, unknown> }).scopes.keys()];
          expect(activeTokens.length).toBe(1);
          const mcpRes = await execSvc.handleMcpHttpRequest({
            method: 'POST',
            authorizationHeader: `Bearer ${activeTokens[0]}`,
            body: {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'delegate_task',
                arguments: {
                  title: 'Update frontend helper',
                  prompt: 'Write frontend/src/other.ts',
                  files_allowed: ['frontend/src/other.ts'],
                  verify: 'echo ok',
                  mode: 'wait',
                },
              },
            },
          });
          expect(mcpRes.statusCode).toBe(200);
          // Subtask's edit in frontend/src/other.ts should now be merged into the parent worktree.
          expect(fs.readFileSync(path.join(runOpts.cwd, 'frontend/src/other.ts'), 'utf8')).toContain(
            'from-subtask',
          );

          fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/app.ts'), 'export const greeting = "parent+sub";\n');
          writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/app.ts', 'frontend/src/other.ts']);
          const line = JSON.stringify({ type: 'result', session_id: 'parent-1', result: 'Done' });
          runOpts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        // Subtask T-001-S1 edits frontend/src/other.ts inside its own nested worktree.
        if (prompt.includes('T-001-S1/result.json')) {
          fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/other.ts'), 'export const other = "from-subtask";\n');
          writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/other.ts']);
          const line = JSON.stringify({ type: 'result', session_id: 'sub-1', result: 'Sub done' });
          runOpts.onStdoutLine?.(line);
          return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }

        return null;
      },
    });
    harness.execSvc.setMcpEndpointUrl('http://127.0.0.1:4173/mcp');

    try {
      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);

      const diff = await harness.execSvc.getTaskDiffForTask(harness.project.id, harness.task.id);
      expect(diff.files.map((f) => f.path)).toEqual(
        expect.arrayContaining(['frontend/src/app.ts', 'frontend/src/other.ts']),
      );

      await harness.execSvc.approveMergeTask(harness.project.id, harness.task.id, { runIntegration: false });
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/app.ts'), 'utf8')).toContain('parent+sub');
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/other.ts'), 'utf8')).toContain('from-subtask');
      expect(await listGitWorktrees(ws.frontendDir)).toHaveLength(1);
      expect(await branchExists(ws.frontendDir, 'dalang/T-001-S1')).toBe(false);
    } finally {
      harness.conn.close();
    }
  });

  it('cleans up nested worktrees and task branches on reject', async () => {
    const ws = createWorkspaceFixture();
    const harness = await setupWorkspaceHarness({
      rootDir: ws.rootDir,
      filesAllowed: ['frontend/src/app.ts'],
      onCoder: async (args, runOpts) => {
        const prompt = args.join('\n');
        if (!prompt.includes('result.json')) return null;
        fs.writeFileSync(path.join(runOpts.cwd, 'frontend/src/app.ts'), 'export const greeting = "rejected";\n');
        writeResultFromPrompt(runOpts.cwd, prompt, ['frontend/src/app.ts']);
        const line = JSON.stringify({ type: 'result', session_id: 'coder-rej', result: 'Done' });
        runOpts.onStdoutLine?.(line);
        return { exitCode: 0, stdout: `${line}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    });

    try {
      await harness.execSvc.startExecution(harness.project.id, {
        taskId: harness.task.id,
        allowUnconfined: true,
      });
      await harness.execSvc.waitForProjectExecution(harness.project.id);

      expect(await branchExists(ws.frontendDir, 'dalang/T-001')).toBe(true);
      await harness.execSvc.rejectTask(harness.project.id, harness.task.id, {
        note: 'Try another approach',
        requeue: true,
      });

      for (const dir of [ws.rootDir, ws.frontendDir, ws.backendDir, ws.schedDir]) {
        expect(await listGitWorktrees(dir)).toHaveLength(1);
        expect(await branchExists(dir, 'dalang/T-001')).toBe(false);
      }
      expect(fs.readFileSync(path.join(ws.frontendDir, 'src/app.ts'), 'utf8')).toContain('"hello"');
    } finally {
      harness.conn.close();
    }
  });
});
