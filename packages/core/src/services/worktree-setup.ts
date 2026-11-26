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
 * sandbox). Every package manager downloads into a fresh throwaway cache, which needs network
 * access and costs some seconds per worktree.
 */
export interface WorktreeSetupStep {
  /** Directory the command runs in (a worktree root or a nested repository inside it). */
  cwd: string;
  command: string;
}

// ponytail: JavaScript lockfiles only; add other ecosystems (uv, poetry, bundler) when a project needs them.
// Each install gets a fresh `mktemp -d` cache that is removed when the command exits. A fixed path would
// be shared on macOS, where the sandbox /tmp is the host /tmp, and a task could plant packages there.
// Windows (cmd.exe) gets the plain commands; a cache write that fails there is only logged.
const FRESH_CACHE = `D=$(mktemp -d) && trap 'rm -rf "$D"' EXIT && `;

function lockfileInstall(dir: string, posix: boolean): { manager: string; command: string } | null {
  const has = (file: string) => fs.existsSync(path.join(dir, file));
  let manager: string;
  let plain: string;
  let cached: string;
  if (has('pnpm-lock.yaml')) {
    // pnpm registers every project inside its store, so even --offline writes there; the user's
    // store cannot be used read-only.
    manager = 'pnpm';
    plain = 'pnpm install --frozen-lockfile';
    cached = `${plain} --store-dir "$D"`;
  } else if (has('bun.lock') || has('bun.lockb')) {
    manager = 'bun';
    plain = 'bun install --frozen-lockfile';
    cached = `BUN_INSTALL_CACHE_DIR="$D" ${plain}`;
  } else if (has('yarn.lock')) {
    manager = 'yarn';
    // Yarn 2+ (a `.yarnrc.yml` next to the lockfile) renamed --frozen-lockfile to --immutable.
    plain = has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    cached = `YARN_CACHE_FOLDER="$D" YARN_ENABLE_GLOBAL_CACHE=false ${plain}`;
  } else if (has('package-lock.json')) {
    manager = 'npm';
    plain = 'npm ci --no-audit --no-fund';
    cached = `${plain} --cache "$D"`;
  } else {
    return null;
  }
  return { manager, command: posix ? FRESH_CACHE + cached : plain };
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
