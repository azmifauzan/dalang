import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A task worktree holds only tracked files, so a JavaScript project has no `node_modules` there and
 * its verify command fails (`tsc: not found`). Agents cannot fix that themselves: the sandbox keeps
 * the package manager's store read-only. DALANG installs the locked dependencies once per worktree,
 * before the agent starts.
 */
export interface WorktreeSetupStep {
  /** Directory the command runs in (a worktree root or a nested repository inside it). */
  cwd: string;
  command: string;
}

// ponytail: JavaScript lockfiles only; add other ecosystems (uv, poetry, bundler) when a project needs them.
const LOCKFILE_INSTALL: Array<{ file: string; manager: string; install: (dir: string) => string }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', install: () => 'pnpm install --frozen-lockfile --prefer-offline' },
  { file: 'bun.lock', manager: 'bun', install: () => 'bun install --frozen-lockfile' },
  { file: 'bun.lockb', manager: 'bun', install: () => 'bun install --frozen-lockfile' },
  {
    file: 'yarn.lock',
    manager: 'yarn',
    // Yarn 2+ (a `.yarnrc.yml` next to the lockfile) renamed --frozen-lockfile to --immutable.
    install: (dir) => (fs.existsSync(path.join(dir, '.yarnrc.yml')) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'),
  },
  { file: 'package-lock.json', manager: 'npm', install: () => 'npm ci --prefer-offline --no-audit --no-fund' },
];

function readPackageJson(dir: string): { scripts?: Record<string, unknown>; workspaces?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The commands that prepare `dir`, or none when it is not a locked JavaScript project or is already
 * installed. A workspace with a root `build` script is also built, because its packages usually
 * import each other's build output (`dist`), which a fresh checkout does not have.
 */
export function detectWorktreeSetup(dir: string): WorktreeSetupStep[] {
  const pkg = readPackageJson(dir);
  if (!pkg || fs.existsSync(path.join(dir, 'node_modules'))) return [];
  const lock = LOCKFILE_INSTALL.find((l) => fs.existsSync(path.join(dir, l.file)));
  if (!lock) return [];
  const steps: WorktreeSetupStep[] = [{ cwd: dir, command: lock.install(dir) }];
  const isWorkspace = fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || pkg.workspaces !== undefined;
  if (isWorkspace && typeof pkg.scripts?.build === 'string') {
    steps.push({ cwd: dir, command: `${lock.manager} run build` });
  }
  return steps;
}

/** Package manager stores and caches an install may write to; only those that exist are opened. */
export function packageManagerCacheDirs(home = os.homedir()): string[] {
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  return [
    path.join(dataHome, 'pnpm'),
    path.join(cacheHome, 'pnpm'),
    path.join(home, '.npm'),
    path.join(cacheHome, 'yarn'),
    path.join(home, '.yarn', 'berry'),
    path.join(home, '.bun', 'install', 'cache'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, 'Library', 'Caches', 'pnpm'),
    path.join(home, 'Library', 'Caches', 'Yarn'),
  ].filter((p) => fs.existsSync(p));
}

/**
 * Whether git ignores `node_modules/` in `dir`. When it does not, installed files would count as task
 * changes (failing the `files_allowed` check) and could land in checkpoint commits, so setup is skipped.
 */
export function isNodeModulesIgnored(dir: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', 'node_modules/.dalang-probe'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
