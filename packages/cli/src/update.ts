import os from 'node:os';
import {
  compareSemver,
  DALANG_VERSION,
  fetchLatestNpmVersion,
  NodeCliRunner,
  type CliRunner,
  type UpdateRegistryFetcher,
} from '@dalang/core';

export type UpdateStatus =
  | 'up-to-date'
  | 'update-available'
  | 'updated'
  | 'check-failed'
  | 'update-failed';

export interface UpdateReport {
  ok: boolean;
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  updated: boolean;
  message: string;
  detail?: string;
}

export interface RunUpdateOptions {
  checkOnly?: boolean;
  currentVersion?: string;
  platform?: NodeJS.Platform;
  updateFetcher?: UpdateRegistryFetcher;
  onStatus?: (line: string) => void;
}

async function findNpmBinary(runner: CliRunner, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === 'win32') {
    return (await runner.which('npm.cmd')) ?? (await runner.which('npm'));
  }
  return runner.which('npm');
}

/**
 * Checks the npm registry for a newer `dalang-cli` release and optionally installs it globally.
 */
export async function runUpdate(
  runner: CliRunner = new NodeCliRunner(),
  opts: RunUpdateOptions = {},
): Promise<UpdateReport> {
  const currentVersion = opts.currentVersion ?? DALANG_VERSION;
  const platform = opts.platform ?? process.platform;
  const fetcher = opts.updateFetcher ?? (() => fetchLatestNpmVersion(4000));

  opts.onStatus?.(`Checking npm registry for DALANG updates (installed: v${currentVersion})...`);

  let latestVersion: string | null = null;
  let fetchError: string | undefined;
  try {
    latestVersion = await fetcher();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (!latestVersion) {
    return {
      ok: false,
      status: 'check-failed',
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      updated: false,
      message: 'Failed to check the latest version from npm registry.',
      detail:
        fetchError || 'Check your network connection or run `npm install -g dalang-cli@latest` manually.',
    };
  }

  if (compareSemver(latestVersion, currentVersion) <= 0) {
    return {
      ok: true,
      status: 'up-to-date',
      currentVersion,
      latestVersion,
      updateAvailable: false,
      updated: false,
      message: `DALANG v${currentVersion} is already up to date (latest: v${latestVersion}).`,
    };
  }

  if (opts.checkOnly) {
    return {
      ok: true,
      status: 'update-available',
      currentVersion,
      latestVersion,
      updateAvailable: true,
      updated: false,
      message: `Update available: v${currentVersion} -> v${latestVersion}.`,
      detail: 'Run `dalang update` or `npm install -g dalang-cli@latest` to install.',
    };
  }

  const npmBinary = await findNpmBinary(runner, platform);
  if (!npmBinary) {
    return {
      ok: false,
      status: 'update-failed',
      currentVersion,
      latestVersion,
      updateAvailable: true,
      updated: false,
      message: 'Could not find `npm` in PATH to install the update.',
      detail: 'Run `npm install -g dalang-cli@latest` manually.',
    };
  }

  opts.onStatus?.(`Updating DALANG from v${currentVersion} to v${latestVersion} via npm...`);

  try {
    const result = await runner.run(npmBinary, ['install', '-g', 'dalang-cli@latest'], {
      cwd: os.homedir(),
      timeoutMs: 300_000,
      idleTimeoutMs: 0,
    });

    if (result.timedOut) {
      return {
        ok: false,
        status: 'update-failed',
        currentVersion,
        latestVersion,
        updateAvailable: true,
        updated: false,
        message: `Updating DALANG to v${latestVersion} timed out.`,
        detail: 'Run `npm install -g dalang-cli@latest` manually.',
      };
    }

    if (result.exitCode !== 0) {
      const output = (result.stderr.trim() || result.stdout.trim()).slice(-800);
      return {
        ok: false,
        status: 'update-failed',
        currentVersion,
        latestVersion,
        updateAvailable: true,
        updated: false,
        message: `Failed to update DALANG to v${latestVersion}.`,
        detail: output || 'Run `npm install -g dalang-cli@latest` manually.',
      };
    }

    return {
      ok: true,
      status: 'updated',
      currentVersion,
      latestVersion,
      updateAvailable: true,
      updated: true,
      message: `Updated DALANG from v${currentVersion} to v${latestVersion}.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'update-failed',
      currentVersion,
      latestVersion,
      updateAvailable: true,
      updated: false,
      message: `Failed to update DALANG to v${latestVersion}.`,
      detail: msg || 'Run `npm install -g dalang-cli@latest` manually.',
    };
  }
}

export function formatUpdateReport(report: UpdateReport): string {
  const lines = [report.message];
  if (report.detail) {
    lines.push(report.detail);
  }
  return lines.join('\n');
}
