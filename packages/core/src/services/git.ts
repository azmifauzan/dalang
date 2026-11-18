import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { writeArtifactFile } from '../safe-fs.js';

const DALANG_COMMITTER_ARGS = ['-c', 'user.name=DALANG', '-c', 'user.email=dalang@local'];
const SAFE_GIT_CONFIG = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'commit.gpgsign=false'];

/**
 * DALANG runs git outside the sandbox on a repo the agent can edit. A clean/smudge filter defined in
 * `.git/config` (and selected by a `.gitattributes` the agent also controls) would run on the host at
 * `git add`, so repo-local config that can execute commands is refused before any git operation.
 */
const UNSAFE_LOCAL_CONFIG = [/^filter\./i, /^include(if\..+)?\.path$/i, /^core\.worktree$/i];

export async function assertRepoConfigSafe(projectPath: string): Promise<void> {
  const gitEntry = path.join(projectPath, '.git');
  if (fs.existsSync(gitEntry) && !fs.lstatSync(gitEntry).isDirectory()) {
    throw new Error('.git is not a plain folder (a gitdir link or symlink); DALANG will not run git on it.');
  }
  const out = await simpleGit({ baseDir: projectPath }).raw(['config', '--local', '--list']).catch(() => '');
  const bad = out
    .split(/\r?\n/)
    .map((line) => line.split('=')[0].trim())
    .filter((key) => UNSAFE_LOCAL_CONFIG.some((re) => re.test(key)));
  if (bad.length > 0) {
    throw new Error(
      `Repository config defines settings that can run commands (${[...new Set(bad)].join(', ')}). Remove them from .git/config before running tasks.`,
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

export async function getChangedFilesSinceCommit(
  projectPath: string,
  baseCommitSha: string | null,
): Promise<string[]> {
  await assertRepoConfigSafe(projectPath);
  const git = openSafeGit(projectPath);
  const changed = new Set<string>();

  if (baseCommitSha) {
    const diffOut = await git.diff(['--name-only', baseCommitSha, 'HEAD']);
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

/** HEAD and the files changed outside `.dalang/`, so rollback can refuse to discard work DALANG did not make. */
export async function getRepoState(
  projectPath: string,
): Promise<{ head: string | null; dirtyFiles: string[] }> {
  await assertRepoConfigSafe(projectPath);
  const status = await openSafeGit(projectPath).status();
  return {
    head: await getHeadCommit(projectPath),
    dirtyFiles: status.files
      .map((f) => f.path)
      .filter((f) => f !== '.dalang' && !f.startsWith('.dalang/')),
  };
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
