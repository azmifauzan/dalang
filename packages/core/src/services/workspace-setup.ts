import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceSetupConfig, WorkspaceSetupProposal } from '@dalang/shared';
import { openSafeGit } from './git.js';
import { detectWorktreeSetup } from './worktree-setup.js';

/**
 * A task worktree is a fresh checkout: no dependencies, generated files, or local files. DALANG does
 * not try to know every stack. The project says what prepares it (a command and a list of local
 * files), the user approves that once, and DALANG replays it. A snapshot of what the command
 * produced lets the next task start from it.
 */

const MAX_INCLUDED_FILES = 50;
const MANIFEST =
  /(^|\/)(package\.json|composer\.json|pyproject\.toml|go\.(mod|sum)|Cargo\.toml|Gemfile|requirements[^/]*\.txt|[^/]*[-.]lock(\.[a-z]+)?|[^/]*\.lockb?)$/i;
/** Setup output that is never kept: local settings and secrets are copied fresh each time. */
const NEVER_SNAPSHOT = /(^|\/)(\.env[^/]*|\.dalang|\.git|auth\.json|\.npmrc)(\/|$)/;

const lines = (out: string) => out.split('\0').filter(Boolean);

async function isIgnored(dir: string, file: string): Promise<boolean> {
  const out = await openSafeGit(dir).raw(['check-ignore', '--', file]).catch(() => '');
  return out.trim() !== '';
}

/** A plain path inside the repository, outside git's and DALANG's own folders. */
export function isLocalFilePath(file: string): boolean {
  if (!file || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || /[*?[\]{}!\\\0]/.test(file)) return false;
  const parts = file.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && p !== '.git' && p !== '.dalang');
}

/** Ignored files that `.worktreeinclude` (gitignore syntax) names, as Claude Code and Conductor read it. */
export async function listWorktreeIncludeFiles(projectPath: string): Promise<string[]> {
  const list = path.join(projectPath, '.worktreeinclude');
  if (!fs.existsSync(list) || !fs.lstatSync(list).isFile()) return [];
  const out = await openSafeGit(projectPath)
    .raw(['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z'])
    .catch(() => '');
  const found: string[] = [];
  for (const file of lines(out)) {
    if (found.length >= MAX_INCLUDED_FILES) break;
    if (/(^|\/)(node_modules|vendor)\//.test(file) || !isLocalFilePath(file)) continue;
    // Only files git already ignores: a copied file must never count as a task change.
    if (await isIgnored(projectPath, file)) found.push(file);
  }
  return found.sort();
}

export function describeFileRisks(projectPath: string, files: string[]): string[] {
  const warnings: string[] = [];
  for (const file of files) {
    if (!/(^|\/)\.env|secret|credential|\.(pem|key)$/i.test(file)) continue;
    warnings.push(`${file} may hold secrets: the agent can read it and send what it reads to its AI provider.`);
    try {
      const full = path.join(projectPath, file);
      if (fs.lstatSync(full).isFile() && /^(DATABASE_URL|DB_HOST|DB_DATABASE)=\S/m.test(fs.readFileSync(full, 'utf8'))) {
        warnings.push(`${file} names a database: a migration or test run by a task would change that database.`);
      }
    } catch {
      // A file that cannot be read gets the first warning only.
    }
  }
  return warnings;
}

function readJson(file: string): any {
  try {
    return fs.lstatSync(file).isFile() ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** A setup command the repository already declares for another tool. */
function declaredCommand(projectPath: string): { command: string; source: string } | null {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const t3 = readJson(path.join(projectPath, 't3.json'))?.scripts;
  if (Array.isArray(t3)) {
    const commands = t3.filter((s) => s?.runOnWorktreeCreate === true).map((s) => text(s.command)).filter(Boolean);
    if (commands.length > 0) return { command: commands.join(' && '), source: 't3.json' };
  }
  const conductor = text(readJson(path.join(projectPath, 'conductor.json'))?.scripts?.setup);
  if (conductor) return { command: conductor, source: 'conductor.json' };
  const cursor = text(readJson(path.join(projectPath, '.cursor', 'environment.json'))?.install);
  if (cursor) return { command: cursor, source: '.cursor/environment.json' };
  return null;
}

/**
 * What DALANG would suggest, or null when there is nothing to ask: a plain JavaScript project is
 * already handled by the built-in install.
 */
export async function proposeWorkspaceSetup(
  projectPath: string,
  leadCommand: string | null = null,
): Promise<WorkspaceSetupProposal | null> {
  const files = await listWorktreeIncludeFiles(projectPath);
  const declared = declaredCommand(projectPath);
  let command = declared?.command ?? null;
  let source = declared?.source ?? null;
  let maintenanceCommand: string | null = null;
  if (!command && leadCommand?.trim()) {
    command = leadCommand.trim();
    source = 'the Lead, from reading the repository';
  }
  // ponytail: one built-in guess for a mixed PHP and JavaScript project, the case that failed in
  // practice. Other stacks come from the repository's own files, the Lead, or the user.
  if (!command && fs.existsSync(path.join(projectPath, 'composer.lock'))) {
    const composer = 'composer install --no-interaction --prefer-dist';
    // The user's checkout is usually installed already; the question is about a fresh task worktree.
    const javascript = detectWorktreeSetup(projectPath, false, true).map((step) => step.command);
    command = [composer, ...javascript].join(' && ');
    // A snapshot is used only for the same lockfiles, so its node_modules need no second install, and
    // `npm ci` would delete it. Without this the snapshot saved no time on a real project.
    maintenanceCommand = [composer, ...javascript.filter((step) => / run build$/.test(step))].join(' && ');
    source = 'composer.lock and the JavaScript lockfile';
  }
  if (!command && files.length === 0) return null;
  return {
    command,
    maintenanceCommand,
    source: source ?? '.worktreeinclude',
    files,
    warnings: describeFileRisks(projectPath, files),
  };
}

/** Copies the approved local files from the user's checkout. Returns what was copied. */
export async function copyApprovedFiles(projectPath: string, worktreePath: string, files: string[]): Promise<string[]> {
  const copied: string[] = [];
  const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
  for (const file of files) {
    if (!isLocalFilePath(file)) continue;
    const source = path.join(projectPath, file);
    const target = path.join(worktreePath, file);
    try {
      if (!fs.lstatSync(source).isFile() || !inside(fs.realpathSync(projectPath), fs.realpathSync(source))) continue;
      if (fs.existsSync(target) || !(await isIgnored(worktreePath, file))) continue;
      // The deepest folder that exists must still be in the worktree, so no link leads outside it.
      let parent = path.dirname(target);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      if (!inside(fs.realpathSync(worktreePath), fs.realpathSync(parent))) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      copied.push(file);
    } catch {
      // A missing or unreadable file is skipped; the setup command reports what it then lacks.
    }
  }
  return copied;
}

/** Changes when the approved commands or any dependency manifest or lockfile in `dir` changes. */
export async function snapshotKey(dir: string, config: WorkspaceSetupConfig): Promise<string> {
  const tracked = lines(await openSafeGit(dir).raw(['ls-files', '-s', '-z']));
  const manifests = tracked.filter((line) => MANIFEST.test(line.slice(line.indexOf('\t') + 1)));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([config.command, config.maintenanceCommand, manifests]))
    .digest('hex')
    .slice(0, 32);
}

const SNAPSHOT_LIST = 'dalang-snapshot.json';

/**
 * Keeps the ignored files and folders the setup produced. Call only before any agent has run in the
 * worktree: the next tasks start from this copy. One snapshot per project is kept.
 */
export async function saveSnapshot(worktreePath: string, projectDir: string, key: string, exclude: string[]): Promise<boolean> {
  const final = path.join(projectDir, key);
  if (fs.existsSync(final)) return false;
  const skipped = new Set(exclude);
  const entries = lines(
    await openSafeGit(worktreePath).raw(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
  )
    .map((entry) => entry.replace(/\/$/, ''))
    .filter((entry) => !NEVER_SNAPSHOT.test(entry) && !skipped.has(entry));
  if (entries.length === 0) return false;
  const draft = `${final}.${crypto.randomUUID()}.tmp`;
  try {
    for (const entry of entries) {
      await fs.promises.cp(path.join(worktreePath, entry), path.join(draft, 'files', entry), {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        mode: fs.constants.COPYFILE_FICLONE,
        filter: (from) => {
          const relative = path.relative(worktreePath, from).split(path.sep).join('/');
          return !NEVER_SNAPSHOT.test(relative) && !skipped.has(relative);
        },
      });
    }
    fs.writeFileSync(path.join(draft, SNAPSHOT_LIST), JSON.stringify(entries));
    fs.renameSync(draft, final);
  } finally {
    fs.rmSync(draft, { recursive: true, force: true });
  }
  for (const other of fs.readdirSync(projectDir)) {
    if (other !== key && !other.endsWith('.tmp')) fs.rmSync(path.join(projectDir, other), { recursive: true, force: true });
  }
  return true;
}

/** Copies a snapshot into a fresh worktree, leaving anything already there. */
export async function restoreSnapshot(worktreePath: string, projectDir: string, key: string): Promise<boolean> {
  const dir = path.join(projectDir, key);
  const entries: unknown = readJson(path.join(dir, SNAPSHOT_LIST));
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const target = path.join(worktreePath, String(entry));
    if (fs.existsSync(target)) continue;
    await fs.promises.cp(path.join(dir, 'files', String(entry)), target, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  }
  return true;
}

/**
 * Runs the project's command with throwaway package caches: the sandbox keeps the user's caches
 * read-only, so an install that writes there would fail.
 */
export function withFreshCaches(command: string, posix = process.platform !== 'win32'): string {
  if (!posix) return command;
  const caches = [
    // No terminal is attached. Without this, pnpm aborts after a snapshot restore: the new store makes
    // it want to remove node_modules, and it will not do that without a confirmation or CI.
    'CI=true',
    'npm_config_cache="$D/npm"',
    // npm warns about pnpm's setting, so it is set only for commands that name pnpm.
    ...(/\bpnpm\b/.test(command) ? ['npm_config_store_dir="$D/pnpm"'] : []),
    'YARN_CACHE_FOLDER="$D/yarn"',
    'YARN_ENABLE_GLOBAL_CACHE=false',
    'BUN_INSTALL_CACHE_DIR="$D/bun"',
    'COMPOSER_CACHE_DIR="$D/composer"',
    'XDG_CACHE_HOME="$D/xdg"',
  ].join(' ');
  return `D=$(mktemp -d) && trap 'rm -rf "$D"' EXIT && export ${caches} && (\n${command}\n)`;
}
