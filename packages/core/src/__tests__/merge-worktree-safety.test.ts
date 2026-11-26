import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { mergeTargetIntoTaskWorktree } from '../services/git.js';
import { cleanupTempDirs, makeTempDir } from './exec-helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'a');
}

it('runs no git in a task worktree whose .git file points at a repository the agent planted', async () => {
  const root = makeTempDir('dalang-wt-safety-');
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'wt');
  initRepo(main);
  git(main, 'worktree', 'add', '-q', '-b', 'dalang/T-001', worktree);

  // A sandboxed agent can rewrite its worktree: point .git at its own repository with a hostile config.
  const planted = path.join(worktree, 'planted');
  initRepo(planted);
  const marker = path.join(root, 'pwned');
  git(planted, 'config', 'core.fsmonitor', `touch ${marker}; false`);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(planted, '.git')}\n`);

  await expect(
    mergeTargetIntoTaskWorktree(main, worktree, 'main', 'merge', undefined, 'dalang/T-001'),
  ).rejects.toThrow(/points outside main repository worktrees/);
  expect(fs.existsSync(marker)).toBe(false);
});
