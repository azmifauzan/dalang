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

export function readArtifactFile(projectPath: string, target: string): string {
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) {
    throw new Error(`${path.relative(projectPath, target)} is not a regular file.`);
  }
  if (!isInside(fs.realpathSync(projectPath), fs.realpathSync(path.dirname(target)))) {
    throw new Error(`${path.relative(projectPath, target)} is outside the project.`);
  }
  return fs.readFileSync(target, 'utf8');
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
  fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, target);
}
