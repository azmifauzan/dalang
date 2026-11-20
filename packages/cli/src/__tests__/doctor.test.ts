import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ReplayCliRunner, SettingsService } from '@dalang/core';
import { formatDoctorReport, runDoctorChecks } from '../doctor.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('dalang doctor', () => {
  it('passes when Node, git, sandbox, data dir, and at least one logged-in CLI are ready', async () => {
    const dataDir = makeTempDir('dalang-doc-ok-');
    const runner = new ReplayCliRunner({
      name: 'doctor-ok',
      binaries: ['git', 'bwrap', 'xdg-dbus-proxy', 'gh', 'claude', 'codex', 'agy'],
      turns: [],
    });

    const report = await runDoctorChecks(runner, {
      platform: 'linux',
      dataDir,
      checkUpdates: false,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'node')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'sandbox')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'data-dir')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'cli-claude-code')?.status).toBe('pass');

    const formatted = formatDoctorReport(report);
    expect(formatted).toContain('[PASS] Node.js runtime');
    expect(formatted).toContain('Start with `npx dalang-cli`.');
    expect(formatted).toContain('To use `dalang` directly, install globally with `npm install -g dalang-cli`.');
  });

  it('reports actionable fixes when sandbox and CLIs are missing', async () => {
    const dataDir = makeTempDir('dalang-doc-fail-');
    const runner = new ReplayCliRunner({
      name: 'doctor-missing',
      binaries: ['git'],
      turns: [],
    });

    const report = await runDoctorChecks(runner, {
      platform: 'linux',
      dataDir,
      checkUpdates: false,
    });
    expect(report.ok).toBe(false);
    const sandbox = report.checks.find((c) => c.id === 'sandbox');
    expect(sandbox?.status).toBe('warn');
    expect(sandbox?.fix).toContain('bubblewrap');
    const anyCli = report.checks.find((c) => c.id === 'cli-any');
    expect(anyCli?.status).toBe('fail');
    expect(anyCli?.fix).toContain('claude auth login');
    expect(formatDoctorReport(report)).toContain('rerun `npx dalang-cli doctor` (or `dalang doctor` after a global install).');
  });

  it('recognizes macOS sandbox-exec and Windows WSL guidance', async () => {
    const dataDir = makeTempDir('dalang-doc-plat-');
    const macRunner = new ReplayCliRunner({
      name: 'doctor-mac',
      binaries: ['git', 'sandbox-exec', 'claude'],
      turns: [],
    });
    const macReport = await runDoctorChecks(macRunner, {
      platform: 'darwin',
      dataDir,
      checkUpdates: false,
    });
    expect(macReport.ok).toBe(true);
    expect(macReport.checks.find((c) => c.id === 'sandbox')?.label).toContain('sandbox-exec');

    const winRunner = new ReplayCliRunner({
      name: 'doctor-win',
      binaries: ['git', 'claude'],
      turns: [],
    });
    const winReport = await runDoctorChecks(winRunner, {
      platform: 'win32',
      dataDir,
      checkUpdates: false,
    });
    expect(winReport.checks.find((c) => c.id === 'sandbox')?.fix).toContain('WSL');
  });

  it('prints an update hint when a newer npm version is available and stays silent offline', async () => {
    const dataDir = makeTempDir('dalang-doc-upd-');
    const runner = new ReplayCliRunner({
      name: 'doctor-upd',
      binaries: ['git', 'bwrap', 'claude'],
      turns: [],
    });

    const newerReport = await runDoctorChecks(runner, {
      platform: 'linux',
      dataDir,
      currentVersion: '0.6.0',
      updateFetcher: async () => '0.7.0',
    });
    expect(newerReport.updateAvailable).toBe(true);
    const updCheck = newerReport.checks.find((c) => c.id === 'update');
    expect(updCheck?.status).toBe('warn');
    expect(updCheck?.fix).toContain('npx dalang-cli@latest');

    const offlineReport = await runDoctorChecks(runner, {
      platform: 'linux',
      dataDir,
      currentVersion: '0.6.0',
      updateFetcher: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(offlineReport.updateAvailable).toBe(false);
    expect(offlineReport.checks.find((c) => c.id === 'update')).toBeUndefined();
  });

  it('skips the registry request when the update check is switched off in Config', async () => {
    const dataDir = makeTempDir('dalang-doc-off-');
    const conn = openDatabase(path.join(dataDir, 'dalang.db'));
    new SettingsService(conn.db).update({ checkForUpdates: false });
    conn.close();
    let calls = 0;
    const report = await runDoctorChecks(
      new ReplayCliRunner({ name: 'doctor-off', binaries: ['git', 'bwrap', 'claude'], turns: [] }),
      {
        platform: 'linux',
        dataDir,
        currentVersion: '0.6.0',
        updateFetcher: async () => {
          calls += 1;
          return '0.7.0';
        },
      },
    );
    expect(calls).toBe(0);
    expect(report.updateAvailable).toBe(false);
  });
});
