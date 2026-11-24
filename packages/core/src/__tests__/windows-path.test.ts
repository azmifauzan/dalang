import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildPathEnv, detectSandboxEngine, NodeCliRunner, wrapWithSandbox } from '../adapters/sandbox.js';
import type { CliRunner } from '../adapters/types.js';
import { ProviderRegistry } from '../adapters/registry.js';
import { ensureSymlinks } from '../services/project.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([true, false])('reports MXC ready only when both confinement probes pass (%s)', async (readOnlyPasses) => {
  const profiles: string[] = [];
  const runner: CliRunner = {
    supportsInteractiveStdin: true,
    async which(name) { return name === 'codex' ? 'codex.exe' : null; },
    async run(command, args) {
      expect(command).toBe('codex.exe');
      expect(args).toContain('windows.sandbox="mxc"');
      profiles.push(args.find((arg) => arg.startsWith('permissions.dalang-runtime='))!);
      const ok = args.at(-1) === 'write' || readOnlyPasses;
      return { exitCode: ok ? 0 : 1, stdout: ok ? 'dalang-mxc-ok\r\n' : '', stderr: '',
        timedOut: false, idleTimedOut: false };
    },
  };
  const status = await detectSandboxEngine(runner, 'win32');
  expect(status.engine).toBe(readOnlyPasses ? 'windows-mxc' : 'none');
  expect(profiles).toHaveLength(2);
  expect(profiles[0]).toMatch(/workspace"="write"/);
  expect(profiles[1]).toMatch(/workspace"="read"/);
  expect(profiles[1]).toMatch(/credential"="deny"/);
  const invocation = await wrapWithSandbox(runner, null, process.cwd(), 'cmd.exe', ['/d', '/s', '/c', '"npm test"'], {
    bindProviderDirs: false, platform: 'win32',
  });
  expect(invocation.sandboxed).toBe(readOnlyPasses);
  expect(invocation.args.slice(-5)).toEqual(readOnlyPasses
    ? ['cmd.exe', '/d', '/s', '/c', '"npm test"'] : ['/d', '/s', '/c', '"npm test"']);
});

it('preserves platform PATH entries including spaces and drive letters', () => {
  const entries = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd', 'D:\\tools']
    : ['/opt/my tools', '/usr/bin'];
  vi.stubEnv('PATH', entries.join(path.delimiter));
  expect(buildPathEnv().PATH?.split(path.delimiter).slice(0, 2)).toEqual(entries);
});

it.skipIf(process.platform !== 'win32')('runs a quoted verification command through the Windows shell', async () => {
  const result = await new ProviderRegistry().runShellCommand(process.cwd(), 'node -e "console.log(42)"');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('42');
  const absolute = await new ProviderRegistry().runShellCommand(process.cwd(), `"${process.execPath}" -e "console.log(43)"`);
  expect(absolute.exitCode).toBe(0);
  expect(absolute.stdout.trim()).toBe('43');
});

it.skipIf(process.platform !== 'win32')('creates instruction pointers without symlink privilege and preserves user instructions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang instructions '));
  try {
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), '# Project rules');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'User rules');
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('Privilege unavailable'), { code: 'EPERM' });
    });
    expect(() => ensureSymlinks(dir)).not.toThrow();
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('User rules');
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('PROJECT.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('finds and runs an executable in a directory containing spaces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang cli '));
  try {
    const name = process.platform === 'win32' ? 'probe.exe' : 'probe';
    const executable = path.join(dir, name);
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
    vi.stubEnv('PATH', dir);
    const runner = new NodeCliRunner();
    expect(await runner.which('probe')).toBe(executable);
    const result = await runner.run(executable, ['--version'], { cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(process.version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
