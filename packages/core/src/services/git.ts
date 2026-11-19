import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { TaskDiffDTO, TaskDiffFileDTO } from '@dalang/shared';
import type { CliRunner } from '../adapters/types.js';
import { writeArtifactFile } from '../safe-fs.js';

const DALANG_COMMITTER_ARGS = ['-c', 'user.name=DALANG', '-c', 'user.email=dalang@local'];
const SAFE_GIT_CONFIG = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'commit.gpgsign=false'];
const MAX_DIFF_CHARS = 200_000;

/**
 * DALANG runs git outside the sandbox on a repo the agent can edit. A clean/smudge filter defined in
 * the repo config or a worktree config (and selected by a `.gitattributes` the agent also controls)
 * would run on the host at `git add`, so config that can execute commands is refused before any git operation.
 */
// Denylist, not allowlist: real repos carry many harmless local keys (remotes, branches, ssh commands).
// Checked on git 2.53 against the commands DALANG runs (status, add, commit, diff, reset, clean, checkout, merge):
// `hook.*`, `trace2.*`, and external diff/merge drivers are refused too so newer git cannot bypass the guard.
const UNSAFE_REPO_CONFIG = [
  /^filter\./i,
  /^include(if\..+)?\.path$/i,
  /^core\.worktree$/i,
  /^hook\./i,
  /^trace2\./i,
  /^diff\.external$/i,
  /^(diff|merge)\..+\.(command|textconv|driver)$/i,
];
// Settings that make git read a config the plain repo config does not show.
const UNSAFE_ANY_SCOPE = [/^extensions\.worktreeconfig$/i];

function assertConfigTokensSafe(out: string): void {
  // `-z --show-scope` prints "scope NUL key NEWLINE value NUL" for each entry.
  const tokens = out.split('\0');
  const bad = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i];
    const key = tokens[i + 1].split('\n')[0];
    if (UNSAFE_ANY_SCOPE.some((re) => re.test(key))) bad.add(key);
    // System and global config are the user's own (Git LFS defines filters there); the rest is agent-reachable.
    if (
      (scope === 'local' || scope === 'worktree' || scope === 'command') &&
      UNSAFE_REPO_CONFIG.some((re) => re.test(key))
    ) {
      bad.add(key);
    }
  }
  if (bad.size > 0) {
    throw new Error(
      `Repository config defines settings that can run commands (${[...bad].join(', ')}). Remove them from .git/config before running tasks.`,
    );
  }
}

export async function assertRepoConfigSafe(projectPath: string): Promise<void> {
  const gitEntry = path.join(projectPath, '.git');
  if (fs.existsSync(gitEntry) && !fs.lstatSync(gitEntry).isDirectory()) {
    throw new Error('.git is not a plain folder (a gitdir link or symlink); DALANG will not run git on it.');
  }
  if (fs.existsSync(path.join(gitEntry, 'config.worktree'))) {
    throw new Error('.git/config.worktree exists; DALANG will not run git on a repo with a worktree-specific config.');
  }

  // Every scope git will use, not just the repo file. An error here must stop the run, never pass it.
  const out = await simpleGit({ baseDir: projectPath }).raw(['config', '--list', '--show-scope', '-z']);
  assertConfigTokensSafe(out);
}

/**
 * Validate a DALANG-managed linked worktree: the main repo must pass `assertRepoConfigSafe`,
 * and `<worktree>/.git` must be a regular file pointing strictly inside `<main>/.git/worktrees/`.
 */
export async function assertWorktreeSafe(mainProjectPath: string, worktreePath: string): Promise<void> {
  await assertRepoConfigSafe(mainProjectPath);
  const dotGit = path.join(worktreePath, '.git');
  if (!fs.existsSync(dotGit)) {
    throw new Error(`Worktree "${worktreePath}" is missing .git metadata.`);
  }
  const stat = fs.lstatSync(dotGit);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Worktree "${worktreePath}" .git is not a plain gitdir file.`);
  }
  const raw = fs.readFileSync(dotGit, 'utf8').trim();
  const match = raw.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    throw new Error(`Worktree "${worktreePath}" .git file is malformed.`);
  }
  const resolvedTarget = fs.realpathSync(path.resolve(worktreePath, match[1].trim()));
  const expectedWorktreesDir = fs.realpathSync(path.join(mainProjectPath, '.git', 'worktrees'));
  if (!resolvedTarget.startsWith(expectedWorktreesDir + path.sep)) {
    throw new Error(
      `Worktree "${worktreePath}" points outside main repository worktrees (${resolvedTarget}).`,
    );
  }
  if (fs.existsSync(path.join(resolvedTarget, 'config.worktree'))) {
    throw new Error('Worktree config.worktree exists; DALANG will not run git on it.');
  }
  const out = await simpleGit({ baseDir: worktreePath }).raw(['config', '--list', '--show-scope', '-z']);
  assertConfigTokensSafe(out);
}

async function assertGitTargetSafe(repoOrWorktreePath: string, mainProjectPath?: string): Promise<void> {
  if (mainProjectPath && path.resolve(repoOrWorktreePath) !== path.resolve(mainProjectPath)) {
    await assertWorktreeSafe(mainProjectPath, repoOrWorktreePath);
    return;
  }
  await assertRepoConfigSafe(repoOrWorktreePath);
}

export function openSafeGit(projectPath: string): SimpleGit {
  return simpleGit({
    baseDir: projectPath,
    config: SAFE_GIT_CONFIG,
    unsafe: { allowUnsafeHooksPath: true },
    allowConfig: ['core.hooksPath', 'core.fsmonitor', 'commit.gpgsign'],
  });
}

async function ensureGitIdentityArgs(git: SimpleGit): Promise<string[]> {
  const [name, email] = await Promise.all([
    git.raw(['config', 'user.name']).catch(() => ''),
    git.raw(['config', 'user.email']).catch(() => ''),
  ]);
  if (name.trim() && email.trim()) {
    return [];
  }
  return DALANG_COMMITTER_ARGS;
}

export async function getHeadCommit(projectPath: string): Promise<string | null> {
  const git = openSafeGit(projectPath);
  try {
    const sha = (await git.revparse(['HEAD'])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export async function getCurrentBranch(
  projectPath: string,
  mainProjectPath?: string,
): Promise<string | null> {
  await assertGitTargetSafe(projectPath, mainProjectPath);
  const git = openSafeGit(projectPath);
  try {
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function branchExists(projectPath: string, branchName: string): Promise<boolean> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  try {
    const out = await git.raw(['show-ref', '--verify', `refs/heads/${branchName}`]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export async function createGitCheckpoint(
  projectPath: string,
  message: string,
  mainProjectPath?: string,
): Promise<{ commitSha: string; createdCommit: boolean }> {
  await assertGitTargetSafe(projectPath, mainProjectPath);
  const git = openSafeGit(projectPath);
  const identityArgs = await ensureGitIdentityArgs(git);
  const head = await getHeadCommit(projectPath);
  const status = await git.status();

  if (!head || status.files.length > 0) {
    await git.raw(['add', '-A']);
    const afterAddStatus = await git.status();
    if (!head || afterAddStatus.staged.length > 0 || afterAddStatus.created.length > 0) {
      const commitArgs = [...identityArgs, 'commit', '--no-verify', '-m', message];
      if (!head && afterAddStatus.files.length === 0) {
        commitArgs.push('--allow-empty');
      }
      await git.raw(commitArgs);
      const nextHead = await getHeadCommit(projectPath);
      if (!nextHead) {
        throw new Error('Failed to resolve HEAD after git checkpoint commit.');
      }
      return { commitSha: nextHead, createdCommit: true };
    }
  }

  if (!head) {
    throw new Error('Failed to resolve HEAD for git checkpoint.');
  }
  return { commitSha: head, createdCommit: false };
}

/**
 * Create a hidden checkpoint commit anchored under `refs/dalang/checkpoints/<refId>` without
 * moving HEAD, touching the real index, or adding noise commits to the user's branch.
 */
export async function createHiddenCheckpointRef(
  projectPath: string,
  refId: string,
  message: string,
  mainProjectPath?: string,
): Promise<{ commitSha: string; refName: string }> {
  await assertGitTargetSafe(projectPath, mainProjectPath);
  const safeId = refId.replace(/[^A-Za-z0-9._/-]/g, '-');
  const refName = `refs/dalang/checkpoints/${safeId}`;
  const git = openSafeGit(projectPath);
  const head = await getHeadCommit(projectPath);
  const tmpIndex = path.join(os.tmpdir(), `dalang-idx-${crypto.randomUUID()}`);

  try {
    const cleanEnv: Record<string, string> = {
      GIT_INDEX_FILE: tmpIndex,
      GIT_AUTHOR_NAME: 'DALANG',
      GIT_AUTHOR_EMAIL: 'dalang@local',
      GIT_COMMITTER_NAME: 'DALANG',
      GIT_COMMITTER_EMAIL: 'dalang@local',
    };
    if (process.env.PATH) cleanEnv.PATH = process.env.PATH;
    if (process.env.HOME) cleanEnv.HOME = process.env.HOME;

    const envGit = simpleGit({
      baseDir: projectPath,
      config: SAFE_GIT_CONFIG,
      unsafe: { allowUnsafeHooksPath: true },
      allowConfig: ['core.hooksPath', 'core.fsmonitor', 'commit.gpgsign'],
      allowEnvironment: [
        'GIT_INDEX_FILE',
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ],
    }).env(cleanEnv);

    if (head) {
      await envGit.raw(['read-tree', head]);
    }
    await envGit.raw(['add', '-A']);
    const treeSha = (await envGit.raw(['write-tree'])).trim();
    const commitArgs = ['commit-tree', treeSha];
    if (head) {
      commitArgs.push('-p', head);
    }
    commitArgs.push('-m', message);
    const commitSha = (await envGit.raw(commitArgs)).trim();
    if (!commitSha) {
      throw new Error('Failed to create hidden checkpoint commit object.');
    }
    await git.raw(['update-ref', refName, commitSha]);
    return { commitSha, refName };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

export async function listHiddenCheckpointRefs(projectPath: string): Promise<Array<{ refName: string; sha: string }>> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  try {
    const out = await git.raw(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/dalang/checkpoints']);
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [refName, sha] = line.split(/\s+/);
        return { refName, sha };
      });
  } catch {
    return [];
  }
}

/**
 * Ensure `mainBranch` exists with at least one commit and is checked out before creating a task branch.
 * When `mainBranch` already has commits, snapshots dirty state into a hidden `refs/dalang/checkpoints/...` ref
 * rather than polluting `mainBranch` with noisy checkpoint commits.
 */
export async function ensureMainBaseline(
  projectPath: string,
  mainBranch: string,
): Promise<{ mainBranch: string; baseMainSha: string; checkpointRef: string | null }> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  const head = await getHeadCommit(projectPath);
  if (!head) {
    const ck = await createGitCheckpoint(projectPath, 'dalang: initial baseline');
    const current = await getCurrentBranch(projectPath);
    if (current && current !== mainBranch) {
      await git.raw(['branch', '-M', current, mainBranch]);
    }
    return { mainBranch, baseMainSha: ck.commitSha, checkpointRef: null };
  }

  const current = await getCurrentBranch(projectPath);
  if (current !== mainBranch && (await branchExists(projectPath, mainBranch))) {
    const state = await getRepoState(projectPath);
    if (state.dirtyFiles.length > 0) {
      throw new Error(
        `Cannot switch to ${mainBranch}: uncommitted edits would be lost (${state.dirtyFiles.slice(0, 3).join(', ')}).`,
      );
    }
    await git.raw(['checkout', mainBranch]);
  }

  const mainHead = await getHeadCommit(projectPath);
  if (!mainHead) {
    throw new Error(`Failed to resolve HEAD on ${mainBranch}.`);
  }
  const hidden = await createHiddenCheckpointRef(
    projectPath,
    `baseline-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
    'dalang: hidden baseline checkpoint',
  );
  return { mainBranch, baseMainSha: mainHead, checkpointRef: hidden.refName };
}

export async function checkoutTaskBranch(
  projectPath: string,
  branchName: string,
  baseBranch: string,
  resetToBase: boolean,
): Promise<{ branchName: string; headSha: string }> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  const exists = await branchExists(projectPath, branchName);

  if (resetToBase || !exists) {
    await git.raw(['checkout', '-B', branchName, baseBranch]);
  } else {
    await git.raw(['checkout', branchName]);
  }

  const headSha = await getHeadCommit(projectPath);
  if (!headSha) throw new Error(`Failed to resolve HEAD on branch ${branchName}.`);
  return { branchName, headSha };
}

export async function checkoutBranch(projectPath: string, branchName: string): Promise<void> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  const current = await getCurrentBranch(projectPath);
  if (current === branchName) return;
  if (!(await branchExists(projectPath, branchName))) return;
  await git.raw(['checkout', branchName]);
}

export async function readFileFromGitCommit(
  projectPath: string,
  commitSha: string,
  relPath: string,
): Promise<string | null> {
  await assertRepoConfigSafe(projectPath);
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return null;
  }
  const git = openSafeGit(projectPath);
  try {
    return await git.raw(['show', `${commitSha}:${normalized}`]);
  } catch {
    return null;
  }
}

export async function getChangedFilesBetween(
  projectPath: string,
  baseSha: string | null,
  headSha: string | null,
  mainProjectPath?: string,
): Promise<string[]> {
  await assertGitTargetSafe(projectPath, mainProjectPath);
  const git = openSafeGit(projectPath);
  const changed = new Set<string>();

  if (baseSha && headSha) {
    const diffOut = await git.diff(['--name-only', baseSha, headSha]);
    for (const line of diffOut.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) changed.add(trimmed);
    }
  } else if (baseSha) {
    const diffOut = await git.diff(['--name-only', baseSha, 'HEAD']);
    for (const line of diffOut.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) changed.add(trimmed);
    }
  }

  const status = await git.status();
  for (const file of status.files) {
    if (file.path) changed.add(file.path);
  }
  return [...changed];
}

export async function getChangedFilesSinceCommit(
  projectPath: string,
  baseCommitSha: string | null,
  mainProjectPath?: string,
): Promise<string[]> {
  return getChangedFilesBetween(projectPath, baseCommitSha, null, mainProjectPath);
}

/** HEAD and the files changed outside `.dalang/`, so rollback can refuse to discard work DALANG did not make. */
export async function getRepoState(
  projectPath: string,
  mainProjectPath?: string,
): Promise<{ head: string | null; branch: string | null; dirtyFiles: string[] }> {
  await assertGitTargetSafe(projectPath, mainProjectPath);
  const status = await openSafeGit(projectPath).status();
  return {
    head: await getHeadCommit(projectPath),
    branch: await getCurrentBranch(projectPath, mainProjectPath),
    dirtyFiles: status.files
      .map((f) => f.path)
      .filter((f) => f !== '.dalang' && !f.startsWith('.dalang/')),
  };
}

function parseUnifiedDiffFiles(rawDiff: string, nameStatusOut: string): TaskDiffFileDTO[] {
  const statusMap = new Map<string, TaskDiffFileDTO['status']>();
  for (const line of nameStatusOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.[0] ?? 'M';
    const filePath = parts[parts.length - 1]?.trim();
    if (!filePath) continue;
    statusMap.set(
      filePath,
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified',
    );
  }

  const sections = rawDiff.split(/(?=^diff --git )/m).filter((s) => s.startsWith('diff --git '));
  const files: TaskDiffFileDTO[] = [];

  for (const section of sections) {
    const headerMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    const filePath = headerMatch ? headerMatch[1].trim() : 'unknown';
    let additions = 0;
    let deletions = 0;
    for (const line of section.split(/\r?\n/)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    files.push({
      path: filePath,
      status: statusMap.get(filePath) ?? 'modified',
      additions,
      deletions,
      patch: section.trimEnd(),
    });
  }

  return files;
}

export async function getTaskDiff(
  projectPath: string,
  taskId: string,
  externalId: string,
  branchName: string | null,
  baseRef: string,
  headRef: string,
): Promise<TaskDiffDTO> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);

  const pathExcludes = ['--', '.', ':(exclude).dalang/logs', ':(exclude).dalang/tmp'];
  const [nameStatusOut, diffOut] = await Promise.all([
    git.raw(['diff', '--name-status', baseRef, headRef, ...pathExcludes]).catch(() => ''),
    git.raw(['diff', '--unified=3', baseRef, headRef, ...pathExcludes]).catch(() => ''),
  ]);

  const truncated = diffOut.length > MAX_DIFF_CHARS;
  const rawDiff = truncated
    ? `${diffOut.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated at ${MAX_DIFF_CHARS} characters]`
    : diffOut;
  const files = parseUnifiedDiffFiles(rawDiff, nameStatusOut);
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    taskId,
    externalId,
    branchName,
    baseCommitSha: baseRef,
    headCommitSha: headRef,
    files,
    rawDiff,
    totalAdditions,
    totalDeletions,
    truncated,
  };
}

export async function mergeTaskBranchToMain(
  projectPath: string,
  mainBranch: string,
  taskBranch: string,
  message: string,
): Promise<{ beforeMergeSha: string; mergeCommitSha: string }> {
  await assertRepoConfigSafe(projectPath);
  const state = await getRepoState(projectPath);
  if (state.dirtyFiles.length > 0) {
    throw new Error(
      `Cannot merge while the working tree has uncommitted changes (${state.dirtyFiles.slice(0, 3).join(', ')}).`,
    );
  }

  const git = openSafeGit(projectPath);
  if (!(await branchExists(projectPath, taskBranch))) {
    throw new Error(`Task branch "${taskBranch}" does not exist.`);
  }
  await checkoutBranch(projectPath, mainBranch);
  const beforeMergeSha = await getHeadCommit(projectPath);
  if (!beforeMergeSha) {
    throw new Error(`Main branch "${mainBranch}" has no commits.`);
  }

  const identityArgs = await ensureGitIdentityArgs(git);
  let mergeOut = '';
  try {
    mergeOut = await git.raw([...identityArgs, 'merge', '--no-ff', '--no-verify', taskBranch, '-m', message]);
  } catch (err) {
    await git.raw(['merge', '--abort']).catch(() => undefined);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Merge conflict or failure merging "${taskBranch}" into "${mainBranch}": ${detail}`);
  }

  // `simple-git.raw(['merge', ...])` can resolve with MERGE_HEAD left on disk when conflicts occur.
  const mergeHeadExists = fs.existsSync(path.join(projectPath, '.git', 'MERGE_HEAD'));
  const postMergeStatus = await git.status();
  const mergeCommitSha = await getHeadCommit(projectPath);
  if (mergeHeadExists || postMergeStatus.conflicted.length > 0) {
    await git.raw(['merge', '--abort']).catch(() => undefined);
    const conflictList =
      postMergeStatus.conflicted.length > 0
        ? ` (${postMergeStatus.conflicted.join(', ')})`
        : '';
    throw new Error(
      `Merge conflict merging "${taskBranch}" into "${mainBranch}"${conflictList}: ${mergeOut.trim() || 'resolve conflicts before merging.'}`,
    );
  }
  if (!mergeCommitSha) {
    throw new Error('Failed to resolve HEAD after merge.');
  }

  await removeWorktreesForBranch(projectPath, taskBranch);
  await git.raw(['branch', '-d', taskBranch]).catch(() => undefined);
  return { beforeMergeSha, mergeCommitSha };
}

export interface GitWorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
}

export async function listGitWorktrees(mainProjectPath: string): Promise<GitWorktreeInfo[]> {
  await assertRepoConfigSafe(mainProjectPath);
  const out = await openSafeGit(mainProjectPath).raw(['worktree', 'list', '--porcelain']);
  const entries: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | null = null;

  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), head: null, branch: null };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export async function removeTaskWorktree(
  mainProjectPath: string,
  worktreePath: string,
): Promise<void> {
  await assertRepoConfigSafe(mainProjectPath);
  const git = openSafeGit(mainProjectPath);
  if (fs.existsSync(worktreePath)) {
    await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  await git.raw(['worktree', 'prune']).catch(() => undefined);
}

export async function removeWorktreesForBranch(
  mainProjectPath: string,
  branchName: string,
): Promise<void> {
  const worktrees = await listGitWorktrees(mainProjectPath).catch(() => []);
  const mainResolved = fs.existsSync(mainProjectPath)
    ? fs.realpathSync(mainProjectPath)
    : path.resolve(mainProjectPath);

  for (const wt of worktrees) {
    if (wt.branch !== branchName) continue;
    const wtResolved = fs.existsSync(wt.path) ? fs.realpathSync(wt.path) : path.resolve(wt.path);
    if (wtResolved === mainResolved) continue;
    await removeTaskWorktree(mainProjectPath, wt.path);
  }
}

export async function createTaskWorktree(
  mainProjectPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  resetToBase: boolean,
): Promise<{ worktreePath: string; branchName: string; headSha: string }> {
  await assertRepoConfigSafe(mainProjectPath);
  const git = openSafeGit(mainProjectPath);
  await git.raw(['worktree', 'prune']).catch(() => undefined);

  if (!resetToBase && fs.existsSync(worktreePath)) {
    try {
      await assertWorktreeSafe(mainProjectPath, worktreePath);
      const currentWtBranch = await getCurrentBranch(worktreePath, mainProjectPath);
      const headSha = await getHeadCommit(worktreePath);
      if (currentWtBranch === branchName && headSha) {
        return { worktreePath, branchName, headSha };
      }
    } catch {
      // Recreate broken/unverified worktree below.
    }
  }

  await removeTaskWorktree(mainProjectPath, worktreePath);
  await removeWorktreesForBranch(mainProjectPath, branchName);

  const mainCurrentBranch = await getCurrentBranch(mainProjectPath);
  if (mainCurrentBranch === branchName && mainCurrentBranch !== baseBranch) {
    await checkoutBranch(mainProjectPath, baseBranch);
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const exists = await branchExists(mainProjectPath, branchName);
  if (resetToBase || !exists) {
    await git.raw(['worktree', 'add', '-B', branchName, worktreePath, baseBranch]);
  } else {
    await git.raw(['worktree', 'add', worktreePath, branchName]);
  }

  await assertWorktreeSafe(mainProjectPath, worktreePath);
  const headSha = await getHeadCommit(worktreePath);
  if (!headSha) throw new Error(`Failed to resolve HEAD in worktree for branch ${branchName}.`);
  return { worktreePath, branchName, headSha };
}

export async function isAncestorCommit(
  projectPath: string,
  ancestorSha: string,
  descendantRef: string,
): Promise<boolean> {
  await assertRepoConfigSafe(projectPath);
  try {
    await openSafeGit(projectPath).raw(['merge-base', '--is-ancestor', ancestorSha, descendantRef]);
    return true;
  } catch {
    return false;
  }
}

export async function deleteTaskBranch(
  projectPath: string,
  mainBranch: string,
  taskBranch: string,
): Promise<void> {
  await assertRepoConfigSafe(projectPath);
  await removeWorktreesForBranch(projectPath, taskBranch);
  const current = await getCurrentBranch(projectPath);
  if (current === taskBranch) {
    await checkoutBranch(projectPath, mainBranch);
  }
  if (await branchExists(projectPath, taskBranch)) {
    await openSafeGit(projectPath).raw(['branch', '-D', taskBranch]);
  }
}

export async function rollbackGitToCheckpoint(
  projectPath: string,
  targetCommitSha: string,
): Promise<void> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  try {
    await git.raw(['rev-parse', '--verify', `${targetCommitSha}^{commit}`]);
  } catch {
    throw new Error(`Checkpoint commit "${targetCommitSha}" no longer exists in this repository.`);
  }

  // Preserve `.dalang/logs/` across the reset so run logs remain readable for post-rollback inspection.
  const logsDir = path.join(projectPath, '.dalang', 'logs');
  const savedLogs: Array<{ name: string; content: string }> = [];
  if (fs.existsSync(logsDir) && !fs.lstatSync(logsDir).isSymbolicLink()) {
    for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        savedLogs.push({
          name: entry.name,
          content: fs.readFileSync(path.join(logsDir, entry.name), 'utf8'),
        });
      }
    }
  }

  // Reset tracked files to the pre-run checkpoint and clean untracked agent outputs,
  // while preserving `.dalang/` artifacts (brief, plan, logs, and task results) for inspection.
  await git.raw(['reset', '--hard', targetCommitSha]);
  await git.raw(['clean', '-fd', '-e', '.dalang']);

  for (const log of savedLogs) {
    const target = path.join(logsDir, log.name);
    if (!fs.existsSync(target)) {
      writeArtifactFile(projectPath, target, log.content, 'refuse');
    }
  }
}

export async function detectDefaultGitRemote(projectPath: string): Promise<string | null> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  try {
    const out = await git.raw(['remote']);
    const remotes = out
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (remotes.length === 0) return null;
    if (remotes.includes('origin')) return 'origin';
    return remotes[0];
  } catch {
    return null;
  }
}

/**
 * Push a refspec (`branch` or `<commitSha>:refs/heads/<branch>`) to a configured git remote.
 * Resolves any revision expression on the LHS of `:` (such as `<mergeSha>^2`) into a plain SHA first.
 * Runs outside the sandbox (DALANG itself owns push credentials, never the agent).
 */
export async function pushRefToRemote(
  projectPath: string,
  remote: string,
  refspec: string,
): Promise<void> {
  await assertRepoConfigSafe(projectPath);
  const cleanRemote = remote.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(cleanRemote)) {
    throw new Error(`Invalid git remote name "${remote}".`);
  }
  const git = openSafeGit(projectPath);
  let effectiveRefspec = refspec;
  const colonIdx = refspec.indexOf(':');
  if (colonIdx > 0) {
    const lhs = refspec.slice(0, colonIdx);
    const rhs = refspec.slice(colonIdx + 1);
    const resolved = (await git.raw(['rev-parse', '--verify', `${lhs}^{commit}`])).trim();
    effectiveRefspec = `${resolved}:${rhs}`;
  }
  await git.raw(['push', cleanRemote, effectiveRefspec]);
}

/**
 * Open a pull request via the official GitHub CLI (`gh pr create`), returning the PR URL.
 */
export async function createGitHubPullRequest(
  runner: CliRunner,
  projectPath: string,
  opts: {
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  },
): Promise<{ prUrl: string; output: string }> {
  await assertRepoConfigSafe(projectPath);
  const ghPath = await runner.which('gh');
  if (!ghPath) {
    throw new Error('GitHub CLI (gh) is not installed. Install gh and run `gh auth login` to open pull requests.');
  }
  const res = await runner.run(
    ghPath,
    [
      'pr',
      'create',
      '--base',
      opts.baseBranch,
      '--head',
      opts.headBranch,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ],
    { cwd: projectPath, timeoutMs: 60_000, idleTimeoutMs: 30_000 },
  );
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  if (res.exitCode !== 0) {
    throw new Error(`gh pr create failed (exit ${res.exitCode ?? 'unknown'}): ${combined.slice(0, 400)}`);
  }
  const urlMatch = combined.match(/https?:\/\/\S+/);
  const prUrl = urlMatch ? urlMatch[0] : combined.split(/\r?\n/).pop()?.trim() ?? '';
  return { prUrl, output: combined };
}