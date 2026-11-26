import fs from 'node:fs';
import path from 'node:path';
import { openSafeGit } from './git.js';

/**
 * A task worktree holds only tracked files, so a JavaScript project has no `node_modules` there and
 * its verify command fails (`tsc: not found`). Agents cannot fix that themselves: the sandbox keeps
 * the package manager's store read-only. DALANG installs the locked dependencies once per worktree,
 * before the agent starts, in the same sandbox.
 *
 * The install runs the repository's lifecycle and build scripts, so it never gets write access to
 * the user's package stores (a script could poison packages that other projects use outside the
 * sandbox). Every package manager downloads into a throwaway cache in the sandbox's private /tmp,
 * which needs network access and costs some seconds per worktree.
 */
export interface WorktreeSetupStep {
  /** Directory the command runs in (a worktree root or a nested repository inside it). */
  cwd: string;
  command: string;
}

// ponytail: JavaScript lockfiles only; add other ecosystems (uv, poetry, bundler) when a project needs them.
// The /tmp caches are private to each sandboxed command and vanish with it. Windows (cmd.exe) gets the
// plain commands: its sandbox has no private /tmp, so a cache write there may fail and is only logged.
function lockfileInstall(dir: string, posix: boolean): { file: string; manager: string; command: string } | null {
  const has = (file: string) => fs.existsSync(path.join(dir, file));
  if (has('pnpm-lock.yaml')) {
    return {
      file: 'pnpm-lock.yaml',
      manager: 'pnpm',
      // pnpm registers every project inside its store, so even --offline writes there; the user's
      // store cannot be used read-only and the install downloads into a sandbox-private store.
      command: `pnpm install --frozen-lockfile${posix ? ' --store-dir /tmp/dalang-pnpm-store' : ''}`,
    };
  }
  if (has('bun.lock') || has('bun.lockb')) {
    return { file: 'bun.lock', manager: 'bun', command: `${posix ? 'BUN_INSTALL_CACHE_DIR=/tmp/dalang-bun-cache ' : ''}bun install --frozen-lockfile` };
  }
  if (has('yarn.lock')) {
    // Yarn 2+ (a `.yarnrc.yml` next to the lockfile) renamed --frozen-lockfile to --immutable.
    const args = has('.yarnrc.yml') ? 'install --immutable' : 'install --frozen-lockfile';
    const env = posix ? 'YARN_CACHE_FOLDER=/tmp/dalang-yarn-cache YARN_ENABLE_GLOBAL_CACHE=false ' : '';
    return { file: 'yarn.lock', manager: 'yarn', command: `${env}yarn ${args}` };
  }
  if (has('package-lock.json')) {
    return {
      file: 'package-lock.json',
      manager: 'npm',
      command: `npm ci --no-audit --no-fund${posix ? ' --cache /tmp/dalang-npm-cache' : ''}`,
    };
  }
  return null;
}

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
export function detectWorktreeSetup(dir: string, posix = process.platform !== 'win32'): WorktreeSetupStep[] {
  const pkg = readPackageJson(dir);
  if (!pkg || fs.existsSync(path.join(dir, 'node_modules'))) return [];
  const lock = lockfileInstall(dir, posix);
  if (!lock) return [];
  const steps: WorktreeSetupStep[] = [{ cwd: dir, command: lock.command }];
  const isWorkspace = fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || pkg.workspaces !== undefined;
  if (isWorkspace && typeof pkg.scripts?.build === 'string') {
    steps.push({ cwd: dir, command: `${lock.manager} run build` });
  }
  return steps;
}

/**
 * Whether git ignores `node_modules/` in `dir`. When it does not, installed files would count as task
 * changes (failing the `files_allowed` check) and could land in checkpoint commits, so setup is skipped.
 * Uses the hardened git invocation, so repository config such as `core.fsmonitor` cannot run commands.
 */
export async function isNodeModulesIgnored(dir: string): Promise<boolean> {
  // check-ignore prints the path when it is ignored; simple-git does not reject on its exit code 1.
  const out = await openSafeGit(dir).raw(['check-ignore', 'node_modules/.dalang-probe']).catch(() => '');
  return out.trim() !== '';
}
