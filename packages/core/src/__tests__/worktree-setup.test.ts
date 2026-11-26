import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { wrapWithSandbox } from '../adapters/sandbox.js';
import type { CliRunner } from '../adapters/types.js';
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

describe('detectWorktreeSetup', () => {
  it('installs and builds a pnpm workspace with a build script', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { build: 'pnpm -r build' } }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    });
    expect(detectWorktreeSetup(dir).map((s) => s.command)).toEqual([
      'pnpm install --frozen-lockfile --prefer-offline',
      'pnpm run build',
    ]);
  });

  it('installs a single package without building it', () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }), 'package-lock.json': '{}' });
    expect(detectWorktreeSetup(dir).map((s) => s.command)).toEqual(['npm ci --prefer-offline --no-audit --no-fund']);
  });

  it('uses --immutable for Yarn 2+ and builds npm-style workspaces', () => {
    const dir = project({
      'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { build: 'yarn workspaces foreach run build' } }),
      'yarn.lock': '',
      '.yarnrc.yml': '',
    });
    expect(detectWorktreeSetup(dir).map((s) => s.command)).toEqual(['yarn install --immutable', 'yarn run build']);
  });

  it('does nothing when already installed, unlocked, or not a JavaScript project', () => {
    expect(detectWorktreeSetup(project({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'node_modules/.keep': '' }))).toEqual([]);
    expect(detectWorktreeSetup(project({ 'package.json': '{}' }))).toEqual([]);
    expect(detectWorktreeSetup(project({ 'README.md': 'hi', 'pnpm-lock.yaml': '' }))).toEqual([]);
  });
});

describe('isNodeModulesIgnored', () => {
  it('is true only when git ignores node_modules', () => {
    const dir = project({ 'package.json': '{}' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(isNodeModulesIgnored(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    expect(isNodeModulesIgnored(dir)).toBe(true);
  });
});

describe('sandbox writablePaths', () => {
  it('binds existing extra paths writable on Linux and skips missing ones', async () => {
    const projectDir = project({ 'package.json': '{}' });
    const cache = project({});
    const runner: CliRunner = { which: async (bin) => `/usr/bin/${bin}`, run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false }) };
    const inv = await wrapWithSandbox(runner, null, projectDir, '/bin/sh', ['-c', 'true'], {
      platform: 'linux',
      bindProviderDirs: false,
      writablePaths: [cache, path.join(cache, 'missing')],
    });
    const binds = inv.args.flatMap((a, i) => (a === '--bind' ? [inv.args[i + 1]] : []));
    expect(binds).toContain(cache);
    expect(binds).not.toContain(path.join(cache, 'missing'));
  });
});
