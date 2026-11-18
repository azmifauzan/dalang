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
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${rel} is not a regular file.`);
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${rel} is not a regular file.`);
    const actual = descriptorPath(fd);
    if (actual && !isInside(root, actual)) throw new Error(`${rel} is outside the project.`);
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
