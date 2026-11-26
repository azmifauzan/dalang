import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../adapters/registry.js';
import type { CliRunner, RunCommandResult } from '../adapters/types.js';
import { openDatabase } from '../db/client.js';
import { reviews, runs, taskRepos, tasks } from '../db/schema.js';
import { getSessionTaskArtifactDir, getTaskWorktreeDir } from '../paths.js';
import { DalangEventBus } from '../services/events.js';
import { ExecutionService } from '../services/executor.js';
import { LeadService } from '../services/lead.js';
import { ProjectService } from '../services/project.js';
import { cleanupTempDirs, makeTempDir } from './exec-helpers.js';

const noopRunner: CliRunner = {
  async which(bin) {
    if (bin === 'claude' || bin === 'codex' || bin === 'agy' || bin === 'git') {
      return `/usr/bin/${bin}`;
    }
    return null;
  },
  async run(): Promise<RunCommandResult> {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    };
  },
};

function initTempRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    ['node_modules/', '.env.local', 'build-cache/', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'restart-fixture', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'index.mjs'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@dalang.local'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Dalang Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function createRealWorktree(
  repoDir: string,
  worktreePath: string,
  branchName: string,
  changeFile: { relPath: string; content: string },
): string {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'main'], {
    cwd: repoDir,
    stdio: 'pipe',
  });
  const target = path.join(worktreePath, changeFile.relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, changeFile.content);
  execFileSync('git', ['add', changeFile.relPath], { cwd: worktreePath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', `Work on ${branchName}`], {
    cwd: worktreePath,
    stdio: 'pipe',
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
}

function startupServices(dbPath: string, worktreesRoot: string) {
  const conn = openDatabase(dbPath);
  const events = new DalangEventBus();
  const registry = new ProviderRegistry(noopRunner);
  const projectSvc = new ProjectService(conn.db);
  const leadSvc = new LeadService(conn.db, registry, events);
  const execSvc = new ExecutionService(conn.db, registry, leadSvc, events, { worktreesRoot });
  return { conn, events, registry, projectSvc, leadSvc, execSvc };
}

function recoveryStatusMessages(
  leadSvc: LeadService,
  projectId: string,
  sessionId: string,
) {
  return leadSvc
    .getDiscussState(projectId, sessionId)
    .messages.filter(
      (m) =>
        m.role === 'system' &&
        m.type === 'text' &&
        m.kind === 'status' &&
        typeof m.content === 'string' &&
        m.content.includes('returned to idle'),
    );
}

afterEach(() => {
  cleanupTempDirs();
});

describe('Startup session recovery and worktree preservation', () => {
  it.each([
    {
      label: 'user-stopped task with saved branch',
      taskStatus: 'stopped' as const,
      runStatus: 'stopped' as const,
      failureReason: 'Stopped by user',
      review: null,
    },
    {
      label: 'awaiting_merge task with pending gate and branch',
      taskStatus: 'awaiting_merge' as const,
      runStatus: 'completed' as const,
      failureReason: null,
      review: { status: 'pass' as const, humanDecision: 'pending' as const },
    },
    {
      label: 'review_failed task with saved findings and branch',
      taskStatus: 'review_failed' as const,
      runStatus: 'completed' as const,
      failureReason: null,
      review: { status: 'fail' as const, humanDecision: 'pending' as const },
    },
    {
      label: 'failed task with preserved worktree and branch',
      taskStatus: 'failed' as const,
      runStatus: 'failed' as const,
      failureReason: 'Verify exited 1',
      review: null,
    },
    {
      label: 'interrupted running task left mid-flight',
      taskStatus: 'running' as const,
      runStatus: 'running' as const,
      failureReason: null,
      review: null,
    },
  ])(
    'returns a working session with $label to idle with one note and does not duplicate on second startup',
    async ({ taskStatus, runStatus, failureReason, review }) => {
      const dbDir = makeTempDir('dalang-restart-db-');
      const dbPath = path.join(dbDir, 'dalang.db');
      const worktreesRoot = makeTempDir('dalang-restart-wt-');
      const repoDir = path.join(makeTempDir('dalang-restart-repo-'), 'app');
      initTempRepo(repoDir);

      const boot0 = startupServices(dbPath, worktreesRoot);
      const project = await boot0.projectSvc.createOrOpen({
        mode: 'open',
        name: 'Restart App',
        path: repoDir,
        initGitIfMissing: false,
        leadProvider: 'claude-code',
      });
      execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Add DALANG files'], { cwd: repoDir, stdio: 'pipe' });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      const idleSession = boot0.leadSvc.createSession(project.id, { mode: 'ask', title: 'Idle chat' });
      const work = boot0.leadSvc.createDirectApprovedTask(project.id, {
        sessionTitle: 'Working session',
        userMessage: 'Implement feature',
        title: 'Update index.mjs',
        goal: 'Update exported value',
        filesAllowed: ['src/index.mjs'],
        acceptanceCriteria: ['value equals 2'],
        verify: 'node -e "process.exit(0)"',
      });

      const branchName = `dalang/${work.task.externalId}`;
      const worktreePath = getTaskWorktreeDir(worktreesRoot, project.id, work.task.externalId);
      const commitAfter = createRealWorktree(repoDir, worktreePath, branchName, {
        relPath: 'src/index.mjs',
        content: 'export const value = 2;\n',
      });

      const ignoredNodeModulesMarker = path.join(worktreePath, 'node_modules', '.dalang-installed');
      const ignoredEnvFile = path.join(worktreePath, '.env.local');
      const ignoredCacheFile = path.join(worktreePath, 'build-cache', 'artifact.bin');
      fs.mkdirSync(path.dirname(ignoredNodeModulesMarker), { recursive: true });
      fs.mkdirSync(path.dirname(ignoredCacheFile), { recursive: true });
      fs.writeFileSync(ignoredNodeModulesMarker, 'installed-v1\n');
      fs.writeFileSync(ignoredEnvFile, 'LOCAL_SECRET=keep-me\n');
      fs.writeFileSync(ignoredCacheFile, 'cache-bytes');

      const now = new Date().toISOString();
      boot0.conn.sqlite
        .prepare('UPDATE tasks SET status = ?, branch_name = ?, review_rounds = ?, updated_at = ? WHERE id = ?')
        .run(taskStatus, branchName, review ? 1 : 0, now, work.task.id);

      boot0.conn.db
        .insert(taskRepos)
        .values({
          id: 'task-repo-1',
          taskId: work.task.id,
          repoPath: '.',
          baseBranch: 'main',
          baseSha,
          branchName,
          worktreePath,
          mergeCommitSha: null,
          prUrl: null,
          pushedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const runId = 'run-1';
      boot0.conn.db
        .insert(runs)
        .values({
          id: runId,
          projectId: project.id,
          taskId: work.task.id,
          profileId: 'profile-coder-small',
          provider: 'claude-code',
          accountKey: 'claude-code',
          model: 'sonnet',
          kind: 'execute',
          branchName,
          worktreePath,
          status: runStatus,
          cliSessionId: null,
          attempt: 1,
          usedFallback: false,
          startedAt: now,
          finishedAt: runStatus === 'running' ? null : now,
          exitCode: runStatus === 'completed' ? 0 : runStatus === 'failed' ? 1 : null,
          failureReason,
          commitBefore: baseSha,
          commitAfter,
          logPath: `.dalang/sessions/${work.session.id}/logs/run-1.log`,
          resultPath: null,
          scopeWarningsJson: '[]',
        })
        .run();

      if (review) {
        const artifactDir = getSessionTaskArtifactDir(repoDir, work.session.id, work.task.externalId);
        fs.mkdirSync(artifactDir, { recursive: true });
        const reviewAbs = path.join(artifactDir, 'review.round-1.json');
        const reviewRel = path.relative(repoDir, reviewAbs).split(path.sep).join('/');
        fs.writeFileSync(
          reviewAbs,
          JSON.stringify(
            {
              task_id: work.task.externalId,
              status: review.status,
              verify_exit_code: review.status === 'pass' ? 0 : 1,
              summary: review.status === 'pass' ? 'Looks good.' : 'Needs adjustment.',
              findings:
                review.status === 'pass'
                  ? []
                  : [{ severity: 'major', file: 'src/index.mjs', note: 'Missing edge check.' }],
            },
            null,
            2,
          ),
        );
        boot0.conn.db
          .insert(reviews)
          .values({
            id: 'rev-1',
            projectId: project.id,
            taskId: work.task.id,
            runId,
            round: 1,
            status: review.status,
            humanDecision: review.humanDecision,
            humanNote: null,
            reviewerProfileId: 'profile-reviewer',
            reviewerProvider: 'codex',
            reviewerModel: 'gpt-5',
            verifyCommand: 'node -e "process.exit(0)"',
            verifyExitCode: review.status === 'pass' ? 0 : 1,
            verifyOutput: 'ok',
            filePath: reviewRel,
            commitSha: commitAfter,
            scopeWarningsJson: '[]',
            createdAt: now,
            decidedAt: null,
          })
          .run();
      }

      boot0.leadSvc.markSessionWorking(project.id, work.session.id);
      expect(boot0.leadSvc.getSession(project.id, work.session.id).workState).toBe('working');
      boot0.conn.close();

      // Startup #1: simulates server restart on the persisted SQLite DB and worktree directory.
      const boot1 = startupServices(dbPath, worktreesRoot);
      try {
        const recovered = boot1.leadSvc.getSession(project.id, work.session.id);
        expect(recovered.workState).toBe('idle');
        expect(boot1.leadSvc.getWorkingSession(project.id)).toBeNull();
        expect(boot1.leadSvc.hasSessionLiveActivity(work.session.id)).toBe(false);
        expect(boot1.leadSvc.hasSessionPendingApprovalOrBranch(work.session.id)).toBe(true);
        expect(boot1.leadSvc.hasSessionUnfinishedWork(work.session.id)).toBe(true);

        const notes1 = recoveryStatusMessages(boot1.leadSvc, project.id, work.session.id);
        expect(notes1).toHaveLength(1);
        expect(recoveryStatusMessages(boot1.leadSvc, project.id, idleSession.id)).toHaveLength(0);

        // Task status, branch, and run failureReason are preserved appropriately.
        const plan1 = boot1.leadSvc.getPlan(project.id, work.session.id)!;
        const task1 = plan1.tasks.find((t) => t.id === work.task.id)!;
        expect(task1.status).toBe(taskStatus === 'running' ? 'stopped' : taskStatus);
        expect(task1.branchName).toBe(branchName);

        const execState1 = await boot1.execSvc.getExecutionState(project.id, work.session.id);
        expect(execState1.activeRun).toBeNull();
        if (taskStatus === 'running') {
          expect(execState1.runs[0]?.status).toBe('stopped');
          expect(execState1.runs[0]?.failureReason).toBe('Interrupted by server restart');
        } else {
          expect(execState1.runs[0]?.status).toBe(runStatus);
          expect(execState1.runs[0]?.failureReason).toBe(failureReason);
        }

        // Gate and review results stay intact.
        if (review) {
          const guard = await boot1.execSvc.getGuardState(project.id, work.session.id);
          const entry = guard.tasks.find((e) => e.task.id === work.task.id);
          expect(entry).toBeDefined();
          expect(entry!.task.status).toBe(taskStatus);
          expect(entry!.latestReview?.status).toBe(review.status);
          expect(entry!.latestReview?.humanDecision).toBe('pending');
          expect(entry!.canApproveMerge).toBe(true);
          expect(entry!.canReject).toBe(true);
          if (review.status === 'fail') {
            expect(entry!.latestReview?.contract.findings).toHaveLength(1);
          }
        }

        // Worktree, git branch, and git-ignored files inside the worktree survive startup.
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect(fs.readFileSync(ignoredNodeModulesMarker, 'utf8')).toBe('installed-v1\n');
        expect(fs.readFileSync(ignoredEnvFile, 'utf8')).toBe('LOCAL_SECRET=keep-me\n');
        expect(fs.readFileSync(ignoredCacheFile, 'utf8')).toBe('cache-bytes');
        const branchRef = execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
          cwd: repoDir,
          encoding: 'utf8',
        }).trim();
        expect(branchRef).toBe(commitAfter);
      } finally {
        boot1.conn.close();
      }

      // Startup #2: must be idempotent and never duplicate the recovery note or touch ignored files.
      const boot2 = startupServices(dbPath, worktreesRoot);
      try {
        expect(boot2.leadSvc.getSession(project.id, work.session.id).workState).toBe('idle');
        expect(recoveryStatusMessages(boot2.leadSvc, project.id, work.session.id)).toHaveLength(1);
        expect(recoveryStatusMessages(boot2.leadSvc, project.id, idleSession.id)).toHaveLength(0);
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect(fs.readFileSync(ignoredNodeModulesMarker, 'utf8')).toBe('installed-v1\n');
        expect(fs.readFileSync(ignoredEnvFile, 'utf8')).toBe('LOCAL_SECRET=keep-me\n');
        expect(fs.readFileSync(ignoredCacheFile, 'utf8')).toBe('cache-bytes');
      } finally {
        boot2.conn.close();
      }
    },
  );

  it('preserves pending gates, review results, failed worktrees, and git-ignored files across restarts and still allows merging the saved gate', async () => {
    const dbDir = makeTempDir('dalang-restart-multi-db-');
    const dbPath = path.join(dbDir, 'dalang.db');
    const worktreesRoot = makeTempDir('dalang-restart-multi-wt-');
    const repoDir = path.join(makeTempDir('dalang-restart-multi-repo-'), 'app');
    initTempRepo(repoDir);

    const boot0 = startupServices(dbPath, worktreesRoot);
    const project = await boot0.projectSvc.createOrOpen({
      mode: 'open',
      name: 'Multi-task Restart App',
      path: repoDir,
      initGitIfMissing: false,
      leadProvider: 'claude-code',
    });
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Add DALANG files'], { cwd: repoDir, stdio: 'pipe' });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Main repo also has git-ignored files that must remain untouched on startup.
    const mainIgnoredEnv = path.join(repoDir, '.env.local');
    const mainIgnoredTmp = path.join(repoDir, '.dalang', 'tmp', 'keep.txt');
    fs.mkdirSync(path.dirname(mainIgnoredTmp), { recursive: true });
    fs.writeFileSync(mainIgnoredEnv, 'MAIN_SECRET=untouched\n');
    fs.writeFileSync(mainIgnoredTmp, 'keep-tmp\n');

    const work = boot0.leadSvc.createDirectApprovedTask(project.id, {
      sessionTitle: 'Multi-task session',
      userMessage: 'Run tasks',
      title: 'Mergeable task',
      goal: 'Add feature A',
      filesAllowed: ['src/a.mjs'],
      acceptanceCriteria: ['src/a.mjs exists'],
      verify: 'node -e "process.exit(0)"',
    });
    const sessionId = work.session.id;
    const planId = work.plan.id;
    const now = new Date().toISOString();

    const failedTaskId = 'task-failed-1';
    const reviewFailedTaskId = 'task-revfail-1';
    const stoppedTaskId = 'task-stopped-1';
    const insertTask = (id: string, externalId: string, title: string, status: string, position: number, branchName: string) => {
      boot0.conn.db
        .insert(tasks)
        .values({
          id,
          planId,
          externalId,
          title,
          milestone: 'M1',
          role: 'engineer',
          complexity: 'low',
          outputKind: 'files',
          status,
          position,
          goal: title,
          filesAllowedJson: JSON.stringify([`src/${externalId.toLowerCase()}.mjs`]),
          filesReferenceJson: '[]',
          acceptanceCriteriaJson: JSON.stringify(['works']),
          verify: 'node -e "process.exit(0)"',
          needsSplit: false,
          splitDepth: 0,
          parentTaskId: null,
          delegatedByRunId: null,
          clientRequestId: null,
          delegationDepth: 0,
          mergeTargetBranch: null,
          profileOverride: null,
          reviewRounds: status === 'review_failed' ? 2 : 0,
          branchName,
          mergeCommitSha: null,
          rejectionNote: null,
          prUrl: null,
          pushedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    };

    const mergeBranch = `dalang/${work.task.externalId}`;
    const mergeWt = getTaskWorktreeDir(worktreesRoot, project.id, work.task.externalId);
    const mergeSha = createRealWorktree(repoDir, mergeWt, mergeBranch, {
      relPath: 'src/a.mjs',
      content: 'export const a = 42;\n',
    });

    const failedBranch = 'dalang/T-002';
    const failedWt = getTaskWorktreeDir(worktreesRoot, project.id, 'T-002');
    const failedSha = createRealWorktree(repoDir, failedWt, failedBranch, {
      relPath: 'src/t-002.mjs',
      content: 'export const broken = true;\n',
    });
    const failedIgnoredFile = path.join(failedWt, 'node_modules', 'pkg', 'index.js');
    fs.mkdirSync(path.dirname(failedIgnoredFile), { recursive: true });
    fs.writeFileSync(failedIgnoredFile, 'module.exports = "preserved";\n');

    const reviewFailedBranch = 'dalang/T-003';
    const reviewFailedWt = getTaskWorktreeDir(worktreesRoot, project.id, 'T-003');
    const reviewFailedSha = createRealWorktree(repoDir, reviewFailedWt, reviewFailedBranch, {
      relPath: 'src/t-003.mjs',
      content: 'export const c = 3;\n',
    });

    const stoppedBranch = 'dalang/T-004';
    const stoppedWt = getTaskWorktreeDir(worktreesRoot, project.id, 'T-004');
    createRealWorktree(repoDir, stoppedWt, stoppedBranch, {
      relPath: 'src/t-004.mjs',
      content: 'export const d = 4;\n',
    });

    boot0.conn.sqlite
      .prepare('UPDATE tasks SET status = ?, branch_name = ?, review_rounds = 1, updated_at = ? WHERE id = ?')
      .run('awaiting_merge', mergeBranch, now, work.task.id);
    insertTask(failedTaskId, 'T-002', 'Failed task', 'failed', 1, failedBranch);
    insertTask(reviewFailedTaskId, 'T-003', 'Review failed task', 'review_failed', 2, reviewFailedBranch);
    insertTask(stoppedTaskId, 'T-004', 'User stopped task', 'stopped', 3, stoppedBranch);

    for (const [id, taskId, branchName, worktreePath] of [
      ['tr-1', work.task.id, mergeBranch, mergeWt],
      ['tr-2', failedTaskId, failedBranch, failedWt],
      ['tr-3', reviewFailedTaskId, reviewFailedBranch, reviewFailedWt],
      ['tr-4', stoppedTaskId, stoppedBranch, stoppedWt],
    ] as const) {
      boot0.conn.db
        .insert(taskRepos)
        .values({
          id,
          taskId,
          repoPath: '.',
          baseBranch: 'main',
          baseSha,
          branchName,
          worktreePath,
          mergeCommitSha: null,
          prUrl: null,
          pushedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    for (const [runId, taskId, branchName, worktreePath, status, sha, reason] of [
      ['run-merge', work.task.id, mergeBranch, mergeWt, 'completed', mergeSha, null],
      ['run-fail', failedTaskId, failedBranch, failedWt, 'failed', failedSha, 'Tests failed'],
      ['run-revfail', reviewFailedTaskId, reviewFailedBranch, reviewFailedWt, 'completed', reviewFailedSha, null],
      ['run-stopped', stoppedTaskId, stoppedBranch, stoppedWt, 'stopped', baseSha, 'Stopped by user'],
    ] as const) {
      boot0.conn.db
        .insert(runs)
        .values({
          id: runId,
          projectId: project.id,
          taskId,
          profileId: 'profile-coder-small',
          provider: 'claude-code',
          accountKey: 'claude-code',
          model: 'sonnet',
          kind: 'execute',
          branchName,
          worktreePath,
          status,
          cliSessionId: null,
          attempt: 1,
          usedFallback: false,
          startedAt: now,
          finishedAt: now,
          exitCode: status === 'completed' ? 0 : 1,
          failureReason: reason,
          commitBefore: baseSha,
          commitAfter: sha,
          logPath: `.dalang/sessions/${sessionId}/logs/${runId}.log`,
          resultPath: null,
          scopeWarningsJson: '[]',
        })
        .run();
    }

    const writeReview = (
      revId: string,
      taskId: string,
      externalId: string,
      runId: string,
      status: 'pass' | 'fail',
      commitSha: string,
    ) => {
      const dir = getSessionTaskArtifactDir(repoDir, sessionId, externalId);
      fs.mkdirSync(dir, { recursive: true });
      const fileAbs = path.join(dir, 'review.round-1.json');
      const fileRel = path.relative(repoDir, fileAbs).split(path.sep).join('/');
      fs.writeFileSync(
        fileAbs,
        JSON.stringify({
          task_id: externalId,
          status,
          verify_exit_code: status === 'pass' ? 0 : 1,
          summary: status === 'pass' ? 'Approved by reviewer' : 'Rejected by reviewer',
          findings:
            status === 'pass'
              ? []
              : [{ severity: 'critical', file: 'src/t-003.mjs', note: 'Missing validation' }],
        }),
      );
      boot0.conn.db
        .insert(reviews)
        .values({
          id: revId,
          projectId: project.id,
          taskId,
          runId,
          round: 1,
          status,
          humanDecision: 'pending',
          humanNote: null,
          reviewerProfileId: 'profile-reviewer',
          reviewerProvider: 'codex',
          reviewerModel: 'gpt-5',
          verifyCommand: 'node -e "process.exit(0)"',
          verifyExitCode: status === 'pass' ? 0 : 1,
          verifyOutput: 'checked',
          filePath: fileRel,
          commitSha,
          scopeWarningsJson: '[]',
          createdAt: now,
          decidedAt: null,
        })
        .run();
    };

    writeReview('rev-merge', work.task.id, work.task.externalId, 'run-merge', 'pass', mergeSha);
    writeReview('rev-fail', reviewFailedTaskId, 'T-003', 'run-revfail', 'fail', reviewFailedSha);

    boot0.leadSvc.markSessionWorking(project.id, sessionId);
    boot0.conn.close();

    // Restart #1 and Restart #2
    const boot1 = startupServices(dbPath, worktreesRoot);
    boot1.conn.close();

    const boot2 = startupServices(dbPath, worktreesRoot);
    try {
      expect(boot2.leadSvc.getSession(project.id, sessionId).workState).toBe('idle');
      const notes = recoveryStatusMessages(boot2.leadSvc, project.id, sessionId);
      expect(notes).toHaveLength(1);
      expect(String(notes[0].content)).toContain('T-001');
      expect(String(notes[0].content)).toContain('T-003');

      // Archiving a recovered idle session with preserved branches/gates is still blocked.
      expect(() => boot2.leadSvc.updateSession(project.id, sessionId, { archived: true })).toThrow(
        /unfinished work/i,
      );

      // Failed worktree and all git-ignored files remain untouched.
      expect(fs.existsSync(failedWt)).toBe(true);
      expect(fs.readFileSync(failedIgnoredFile, 'utf8')).toBe('module.exports = "preserved";\n');
      expect(fs.readFileSync(mainIgnoredEnv, 'utf8')).toBe('MAIN_SECRET=untouched\n');
      expect(fs.readFileSync(mainIgnoredTmp, 'utf8')).toBe('keep-tmp\n');

      // Guard still exposes both the pending merge gate and the failed review.
      const guard = await boot2.execSvc.getGuardState(project.id, sessionId);
      const mergeGate = guard.tasks.find((entry) => entry.task.id === work.task.id);
      const failedReviewEntry = guard.tasks.find((entry) => entry.task.id === reviewFailedTaskId);
      expect(mergeGate?.canApproveMerge).toBe(true);
      expect(mergeGate?.latestReview?.status).toBe('pass');
      expect(failedReviewEntry?.latestReview?.status).toBe('fail');
      expect(failedReviewEntry?.latestReview?.contract.findings[0]?.note).toBe('Missing validation');

      // Even while another session is working, approving the preserved merge gate succeeds without
      // flipping this idle session back to working.
      const otherSession = boot2.leadSvc.createSession(project.id, { mode: 'quick', title: 'Other active session' });
      boot2.leadSvc.markSessionWorking(project.id, otherSession.id);

      const merged = await boot2.execSvc.approveMergeTask(project.id, work.task.id, {
        runIntegration: false,
      });
      expect(merged.task.status).toBe('done');
      expect(fs.readFileSync(path.join(repoDir, 'src', 'a.mjs'), 'utf8')).toContain('export const a = 42;');
      expect(boot2.leadSvc.getSession(project.id, sessionId).workState).toBe('idle');
      expect(boot2.leadSvc.getSession(project.id, otherSession.id).workState).toBe('working');

      // Failed worktree and its git-ignored file are still preserved after merging T-001.
      expect(fs.existsSync(failedWt)).toBe(true);
      expect(fs.readFileSync(failedIgnoredFile, 'utf8')).toBe('module.exports = "preserved";\n');
    } finally {
      boot2.conn.close();
    }
  });

  it('recovers a working session with no tasks at all to idle with one note and stays idempotent across restarts', async () => {
    const dbDir = makeTempDir('dalang-restart-empty-db-');
    const dbPath = path.join(dbDir, 'dalang.db');
    const worktreesRoot = makeTempDir('dalang-restart-empty-wt-');
    const repoDir = path.join(makeTempDir('dalang-restart-empty-repo-'), 'app');
    initTempRepo(repoDir);

    const boot0 = startupServices(dbPath, worktreesRoot);
    const project = await boot0.projectSvc.createOrOpen({
      mode: 'open',
      name: 'Empty Working App',
      path: repoDir,
      initGitIfMissing: false,
      leadProvider: 'claude-code',
    });
    const staleWorking = boot0.leadSvc.createSession(project.id, { mode: 'auto', title: 'Stale working' });
    boot0.leadSvc.markSessionWorking(project.id, staleWorking.id);
    boot0.conn.close();

    const boot1 = startupServices(dbPath, worktreesRoot);
    try {
      expect(boot1.leadSvc.getSession(project.id, staleWorking.id).workState).toBe('idle');
      expect(recoveryStatusMessages(boot1.leadSvc, project.id, staleWorking.id)).toHaveLength(1);
    } finally {
      boot1.conn.close();
    }

    const boot2 = startupServices(dbPath, worktreesRoot);
    try {
      expect(boot2.leadSvc.getSession(project.id, staleWorking.id).workState).toBe('idle');
      expect(recoveryStatusMessages(boot2.leadSvc, project.id, staleWorking.id)).toHaveLength(1);
    } finally {
      boot2.conn.close();
    }
  });
});
