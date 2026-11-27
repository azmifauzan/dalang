import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The agent runs inside the sandbox but can still plant symlinks in the project folder.
// DALANG itself runs outside the sandbox, so every read or write of an agent-reachable
// path goes through these helpers instead of following links.

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Create `dir` and prove it resolves inside the project, so a planted symlink cannot redirect writes. */
export function ensureProjectDir(projectPath: string, dir: string): void {
  const root = fs.realpathSync(projectPath);
  const refuse = () =>
    new Error(`Refusing to use ${path.relative(projectPath, dir)}: it points outside the project.`);

  // Check the nearest existing ancestor before creating anything, so mkdir never writes through a link.
  let existing = dir;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!isInside(root, fs.realpathSync(existing))) throw refuse();

  fs.mkdirSync(dir, { recursive: true });
  if (!isInside(root, fs.realpathSync(dir))) throw refuse();
}

/** Where an open descriptor really points (Linux); null elsewhere, where the path checks still apply. */
function descriptorPath(fd: number): string | null {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

export function readArtifactFile(projectPath: string, target: string): string {
  const rel = path.relative(projectPath, target);
  const root = fs.realpathSync(projectPath);
  if (!isInside(root, fs.realpathSync(path.dirname(target)))) {
    throw new Error(`${rel} is outside the project.`);
  }

  // One descriptor for check and read: O_NOFOLLOW refuses a link at the final component, and
  // fstat/readlink on the descriptor cannot be raced the way a separate lstat and read can.
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO the agent planted must return at once instead of hanging DALANG.
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${rel} is not a regular file.`);
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${rel} is not a regular file.`);

    // Fail closed: prove the descriptor is the file inside the project, by path where the OS
    // can tell us (Linux) and by device and inode against the resolved path everywhere else.
    const actual = descriptorPath(fd);
    if (actual !== null) {
      if (!isInside(root, actual)) throw new Error(`${rel} is outside the project.`);
    } else {
      const resolved = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
      const check = fs.lstatSync(resolved);
      if (!check.isFile() || check.ino !== opened.ino || check.dev !== opened.dev) {
        throw new Error(`${rel} changed while it was being read.`);
      }
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function writeArtifactFile(
  projectPath: string,
  target: string,
  content: string,
  onLink: 'replace' | 'refuse' = 'replace',
): void {
  ensureProjectDir(projectPath, path.dirname(target));
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(target);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink() && onLink === 'refuse') {
    throw new Error(`${path.relative(projectPath, target)} is a symlink; refusing to write through it.`);
  }
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`${path.relative(projectPath, target)} is not a regular file.`);
  }
  // Write beside the target and rename over it: rename replaces a planted link instead of following it.
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(
    temp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  // Re-check the folder right before the rename so a swap after the first check is caught.
  if (!isInside(fs.realpathSync(projectPath), fs.realpathSync(path.dirname(target)))) {
    fs.rmSync(temp, { force: true });
    throw new Error(`${path.relative(projectPath, target)} is outside the project.`);
  }
  fs.renameSync(temp, target);
}

/** Remove an agent-reachable file, after proving its folder is not a link that leads outside the project. */
export function removeArtifactFile(projectPath: string, target: string): void {
  ensureProjectDir(projectPath, path.dirname(target));
  fs.rmSync(target, { force: true });
}

/** Entries `.dalang/.gitignore` needs so run logs and scratch files never show up as untracked. */
/**
 * DALANG's own files never belong to the user's history (B31): session artifacts stay on disk, and
 * the ignore file hides itself so nothing under `.dalang/` shows up as a change.
 */
export const DALANG_IGNORE_ENTRIES = ['tmp/', 'sessions/*/tmp/', 'sessions/*/logs/', 'sessions/', 'tasks/', 'answers/', '.gitignore'];

/**
 * Create `.dalang/.gitignore`, or append the entries an older DALANG wrote without (v0.6 and earlier
 * only ignored `tmp/`). Lines the user added are kept.
 */
export function ensureDalangIgnore(projectPath: string): void {
  const target = path.join(projectPath, '.dalang', '.gitignore');
  const existing = fs.existsSync(target) ? readArtifactFile(projectPath, target) : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = DALANG_IGNORE_ENTRIES.filter((e) => !have.has(e));
  if (missing.length === 0) return;
  const base = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeArtifactFile(projectPath, target, `${base}${missing.join('\n')}\n`, 'refuse');
}
