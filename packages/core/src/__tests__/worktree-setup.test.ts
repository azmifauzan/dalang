import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectWorktreeSetup, isNodeModulesIgnored } from '../services/worktree-setup.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-setup-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const FRESH = `D=$(mktemp -d) && trap 'rm -rf "$D"' EXIT && `;
const commands = (dir: string, posix = true) => detectWorktreeSetup(dir, posix).map((s) => s.command);

describe('detectWorktreeSetup', () => {
  it('installs a pnpm workspace into a sandbox-private store, then builds', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { build: 'pnpm -r build' } }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    });
    expect(commands(dir)).toEqual([
      `${FRESH}pnpm install --frozen-lockfile --store-dir "$D"`,
      'pnpm run build',
    ]);
  });

  it('gives every install a fresh cache that is removed afterwards, never the user home or a fixed path', () => {
    const npm = project({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }), 'package-lock.json': '{}' });
    const yarn = project({ 'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { build: 'x' } }), 'yarn.lock': '', '.yarnrc.yml': '' });
    const bun = project({ 'package.json': '{}', 'bun.lock': '' });
    // A single package is not built; a workspace is.
    expect(commands(npm)).toEqual([`${FRESH}npm ci --no-audit --no-fund --cache "$D"`]);
    expect(commands(yarn)).toEqual([
      `${FRESH}YARN_CACHE_FOLDER="$D" YARN_ENABLE_GLOBAL_CACHE=false yarn install --immutable`,
      'yarn run build',
    ]);
    expect(commands(bun)).toEqual([`${FRESH}BUN_INSTALL_CACHE_DIR="$D" bun install --frozen-lockfile`]);
  });

  it('uses plain commands on Windows', () => {
    const dir = project({ 'package.json': '{}', 'yarn.lock': '' });
    expect(commands(dir, false)).toEqual(['yarn install --frozen-lockfile']);
  });

  it('does nothing when already installed, unlocked, or not a JavaScript project', () => {
    expect(commands(project({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'node_modules/.keep': '' }))).toEqual([]);
    expect(commands(project({ 'package.json': '{}' }))).toEqual([]);
    expect(commands(project({ 'README.md': 'hi', 'pnpm-lock.yaml': '' }))).toEqual([]);
  });
});

it('the fresh-cache prefix creates a private directory, keeps the exit code, and removes the directory', () => {
  const out = execFileSync('/bin/sh', ['-c', `${FRESH}echo "$D"; test -d "$D" && [ "$(stat -c %a "$D" 2>/dev/null || stat -f %Lp "$D")" = 700 ] && echo private`]).toString().split('\n');
  expect(out[1]).toBe('private');
  expect(fs.existsSync(out[0])).toBe(false);
  let code = 0;
  try {
    execFileSync('/bin/sh', ['-c', `${FRESH}exit 3`]);
  } catch (err) {
    code = (err as { status: number }).status;
  }
  expect(code).toBe(3);
});

describe('isNodeModulesIgnored', () => {
  it('is true only when git ignores node_modules', async () => {
    const dir = project({ 'package.json': '{}' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(await isNodeModulesIgnored(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    expect(await isNodeModulesIgnored(dir)).toBe(true);
  });

  it('does not run a command planted in the repository config', async () => {
    const dir = project({ 'package.json': '{}', '.gitignore': 'node_modules\n' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const marker = path.join(dir, 'pwned');
    execFileSync('git', ['config', 'core.fsmonitor', `touch ${marker}; false`], { cwd: dir });
    expect(await isNodeModulesIgnored(dir)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
