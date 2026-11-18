import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { TaskDiffDTO, TaskDiffFileDTO } from '@dalang/shared';
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

export async function getCurrentBranch(projectPath: string): Promise<string | null> {
  await assertRepoConfigSafe(projectPath);
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
    await git.raw(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createGitCheckpoint(
  projectPath: string,
  message: string,
): Promise<{ commitSha: string; createdCommit: boolean }> {
  await assertRepoConfigSafe(projectPath);
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
 * Ensure `mainBranch` exists with at least one commit and is checked out before creating a task branch.
 */
export async function ensureMainBaseline(
  projectPath: string,
  mainBranch: string,
): Promise<{ mainBranch: string; baseMainSha: string }> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  const head = await getHeadCommit(projectPath);
  if (!head) {
    const ck = await createGitCheckpoint(projectPath, 'dalang: initial baseline');
    const current = await getCurrentBranch(projectPath);
    if (current && current !== mainBranch) {
      await git.raw(['branch', '-M', current, mainBranch]);
    }
    return { mainBranch, baseMainSha: ck.commitSha };
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

  const ck = await createGitCheckpoint(projectPath, 'dalang: checkpoint baseline');
  return { mainBranch, baseMainSha: ck.commitSha };
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
): Promise<string[]> {
  await assertRepoConfigSafe(projectPath);
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
): Promise<string[]> {
  return getChangedFilesBetween(projectPath, baseCommitSha, null);
}

/** HEAD and the files changed outside `.dalang/`, so rollback can refuse to discard work DALANG did not make. */
export async function getRepoState(
  projectPath: string,
): Promise<{ head: string | null; branch: string | null; dirtyFiles: string[] }> {
  await assertRepoConfigSafe(projectPath);
  const status = await openSafeGit(projectPath).status();
  return {
    head: await getHeadCommit(projectPath),
    branch: await getCurrentBranch(projectPath),
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

  await git.raw(['branch', '-d', taskBranch]).catch(() => undefined);
  return { beforeMergeSha, mergeCommitSha };
}

export async function deleteTaskBranch(
  projectPath: string,
  mainBranch: string,
  taskBranch: string,
): Promise<void> {
  await assertRepoConfigSafe(projectPath);
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