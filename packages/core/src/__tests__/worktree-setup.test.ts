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

const commands = (dir: string, posix = true) => detectWorktreeSetup(dir, posix).map((s) => s.command);

describe('detectWorktreeSetup', () => {
  it('installs a pnpm workspace into a sandbox-private store, then builds', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { build: 'pnpm -r build' } }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    });
    expect(commands(dir)).toEqual([
      'pnpm install --frozen-lockfile --store-dir /tmp/dalang-pnpm-store',
      'pnpm run build',
    ]);
  });

  it('keeps every write cache inside the sandbox /tmp, never the user home', () => {
    const npm = project({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }), 'package-lock.json': '{}' });
    const yarn = project({ 'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { build: 'x' } }), 'yarn.lock': '', '.yarnrc.yml': '' });
    const bun = project({ 'package.json': '{}', 'bun.lock': '' });
    // A single package is not built; a workspace is.
    expect(commands(npm)).toEqual(['npm ci --no-audit --no-fund --cache /tmp/dalang-npm-cache']);
    expect(commands(yarn)).toEqual([
      'YARN_CACHE_FOLDER=/tmp/dalang-yarn-cache YARN_ENABLE_GLOBAL_CACHE=false yarn install --immutable',
      'yarn run build',
    ]);
    expect(commands(bun)).toEqual(['BUN_INSTALL_CACHE_DIR=/tmp/dalang-bun-cache bun install --frozen-lockfile']);
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
