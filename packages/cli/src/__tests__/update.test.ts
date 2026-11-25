import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '@dalang/core';
import { main, resolveCliCommand } from '../cli.js';
import {
  formatConnectedClisUpdateLines,
  formatUpdateReport,
  runConnectedClisUpdate,
  runUpdate,
} from '../update.js';

interface RecordedRun {
  command: string;
  args: string[];
  options: RunCommandOptions;
}

class FakeCliRunner implements CliRunner {
  readonly runs: RecordedRun[] = [];

  constructor(
    private readonly binaries: Record<string, string> = { npm: '/usr/local/bin/npm' },
    private readonly handler: (
      command: string,
      args: string[],
      options: RunCommandOptions,
    ) => Promise<RunCommandResult> | RunCommandResult = () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      idleTimedOut: false,
    }),
  ) {}

  async which(binary: string): Promise<string | null> {
    return this.binaries[binary] ?? null;
  }

  async run(
    command: string,
    args: string[],
    options: RunCommandOptions,
  ): Promise<RunCommandResult> {
    this.runs.push({ command, args, options });
    return this.handler(command, args, options);
  }
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('dalang update', () => {
  it('reports up-to-date without running npm when already on the latest version', async () => {
    const runner = new FakeCliRunner();
    const statuses: string[] = [];

    const report = await runUpdate(runner, {
      currentVersion: '0.7.2',
      updateFetcher: async () => '0.7.2',
      onStatus: (line) => statuses.push(line),
    });

    expect(report).toEqual({
      ok: true,
      status: 'up-to-date',
      currentVersion: '0.7.2',
      latestVersion: '0.7.2',
      updateAvailable: false,
      updated: false,
      message: 'DALANG v0.7.2 is already up to date (latest: v0.7.2).',
    });
    expect(runner.runs).toHaveLength(0);
    expect(statuses).toHaveLength(1);
    expect(formatUpdateReport(report)).toContain('already up to date');
  });

  it('reports update-available without installing when checkOnly is true', async () => {
    const runner = new FakeCliRunner();

    const report = await runUpdate(runner, {
      checkOnly: true,
      currentVersion: '0.7.2',
      updateFetcher: async () => '0.8.0',
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('update-available');
    expect(report.updateAvailable).toBe(true);
    expect(report.updated).toBe(false);
    expect(report.latestVersion).toBe('0.8.0');
    expect(runner.runs).toHaveLength(0);
    expect(formatUpdateReport(report)).toContain('v0.7.2 -> v0.8.0');
  });

  it('installs the latest version via npm when a newer version is available', async () => {
    const runner = new FakeCliRunner({ npm: '/usr/local/bin/npm' });

    const report = await runUpdate(runner, {
      platform: 'linux',
      currentVersion: '0.7.2',
      updateFetcher: async () => '0.8.0',
    });

    expect(report).toEqual({
      ok: true,
      status: 'updated',
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      updateAvailable: true,
      updated: true,
      message: 'Updated DALANG from v0.7.2 to v0.8.0.',
    });
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.command).toBe('/usr/local/bin/npm');
    expect(runner.runs[0]?.args).toEqual(['install', '-g', 'dalang-cli@latest']);
  });

  it('uses npm.cmd on Windows when available', async () => {
    const runner = new FakeCliRunner({ 'npm.cmd': 'C:\\Program Files\\nodejs\\npm.cmd' });

    const report = await runUpdate(runner, {
      platform: 'win32',
      currentVersion: '0.7.2',
      updateFetcher: async () => '0.8.0',
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('updated');
    expect(runner.runs[0]?.command).toBe('C:\\Program Files\\nodejs\\npm.cmd');
  });

  it('returns check-failed when registry lookup fails or returns null', async () => {
    const runner = new FakeCliRunner();

    const offline = await runUpdate(runner, {
      currentVersion: '0.7.2',
      updateFetcher: async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
    });
    expect(offline.ok).toBe(false);
    expect(offline.status).toBe('check-failed');
    expect(offline.detail).toContain('ENOTFOUND');
    expect(runner.runs).toHaveLength(0);

    const empty = await runUpdate(runner, {
      currentVersion: '0.7.2',
      updateFetcher: async () => null,
    });
    expect(empty.ok).toBe(false);
    expect(empty.status).toBe('check-failed');
  });

  it('returns update-failed when npm is missing, times out, or exits non-zero', async () => {
    const missingNpm = await runUpdate(new FakeCliRunner({}), {
      currentVersion: '0.7.2',
      updateFetcher: async () => '0.8.0',
    });
    expect(missingNpm.ok).toBe(false);
    expect(missingNpm.status).toBe('update-failed');
    expect(missingNpm.message).toContain('npm');

    const timedOut = await runUpdate(
      new FakeCliRunner({ npm: '/usr/local/bin/npm' }, () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        idleTimedOut: false,
      })),
      {
        currentVersion: '0.7.2',
        updateFetcher: async () => '0.8.0',
      },
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.status).toBe('update-failed');
    expect(timedOut.message).toContain('timed out');

    const failedExit = await runUpdate(
      new FakeCliRunner({ npm: '/usr/local/bin/npm' }, () => ({
        exitCode: 243,
        stdout: '',
        stderr: 'EACCES: permission denied',
        timedOut: false,
        idleTimedOut: false,
      })),
      {
        currentVersion: '0.7.2',
        updateFetcher: async () => '0.8.0',
      },
    );
    expect(failedExit.ok).toBe(false);
    expect(failedExit.status).toBe('update-failed');
    expect(failedExit.detail).toContain('EACCES');
  });

  it('dispatches `dalang update --check --json` through CLI main without starting the server', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '0.0.1' }), { status: 200 }),
    );

    await main(['update', '--check', '--json']);

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as { ok: boolean; status: string; latestVersion: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('up-to-date');
    expect(parsed.latestVersion).toBe('0.0.1');
  });

  it('resolves update flags for --clis and --all', () => {
    expect(resolveCliCommand(['update', '--clis'])).toEqual({
      kind: 'update',
      asJson: false,
      checkOnly: false,
      clisOnly: true,
      includeClis: true,
    });
    expect(resolveCliCommand(['update', '--all', '--json'])).toEqual({
      kind: 'update',
      asJson: true,
      checkOnly: false,
      clisOnly: false,
      includeClis: true,
    });
  });

  it('updates only connected CLIs, skips missing/logged-out ones, and isolates failures', async () => {
    let claudeVersion = '2.1.0';
    const runner = new FakeCliRunner(
      { claude: '/usr/bin/claude', codex: '/usr/bin/codex' },
      (command, args) => {
        if (command === '/usr/bin/claude') {
          if (args[0] === '--version') return { exitCode: 0, stdout: claudeVersion, stderr: '', timedOut: false, idleTimedOut: false };
          if (args[0] === 'auth') return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '', timedOut: false, idleTimedOut: false };
          if (args[0] === 'update') {
            claudeVersion = '2.2.0';
            return { exitCode: 0, stdout: 'Updated to 2.2.0', stderr: '', timedOut: false, idleTimedOut: false };
          }
        }
        if (command === '/usr/bin/codex') {
          if (args[0] === '--version') return { exitCode: 0, stdout: '0.40.0', stderr: '', timedOut: false, idleTimedOut: false };
          if (args[0] === 'login') return { exitCode: 1, stdout: '', stderr: 'Not logged in', timedOut: false, idleTimedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    );

    const report = await runConnectedClisUpdate(runner);
    expect(report.ok).toBe(true);
    expect(report.updatedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(report.skippedCount).toBe(2);
    expect(report.results.find((r) => r.provider === 'claude-code')).toMatchObject({
      status: 'updated',
      beforeVersion: '2.1.0',
      afterVersion: '2.2.0',
      message: '2.1.0 -> 2.2.0',
    });
    expect(report.results.find((r) => r.provider === 'codex')).toMatchObject({
      status: 'skipped',
    });
    expect(report.results.find((r) => r.provider === 'antigravity')).toMatchObject({
      status: 'skipped',
      message: 'Not installed',
    });
    expect(formatConnectedClisUpdateLines(report.results).join('\n')).toContain('2.1.0 -> 2.2.0');
  });
});
