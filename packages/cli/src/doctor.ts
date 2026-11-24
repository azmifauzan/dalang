import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareSemver,
  DALANG_VERSION,
  detectSandboxEngine,
  ensureDir,
  fetchLatestNpmVersion,
  getDalangHome,
  NodeCliRunner,
  openDatabase,
  ProviderRegistry,
  SettingsService,
  type CliRunner,
  type UpdateRegistryFetcher,
} from '@dalang/core';

export type DoctorSeverity = 'pass' | 'warn' | 'fail';

export interface DoctorCheckItem {
  id: string;
  label: string;
  status: DoctorSeverity;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  nodeVersion: string;
  version: string;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  checks: DoctorCheckItem[];
}

/** Honors the Config → General toggle; a fresh install (no database yet) keeps the default, on. */
function updateCheckEnabled(dataDir: string): boolean {
  const dbFile = path.join(dataDir, 'dalang.db');
  if (!fs.existsSync(dbFile)) return true;
  try {
    const conn = openDatabase(dbFile);
    try {
      return new SettingsService(conn.db).checkForUpdates();
    } finally {
      conn.close();
    }
  } catch {
    return true;
  }
}

export async function runDoctorChecks(
  runner: CliRunner = new NodeCliRunner(),
  opts: {
    platform?: NodeJS.Platform;
    dataDir?: string;
    checkUpdates?: boolean;
    updateFetcher?: UpdateRegistryFetcher;
    currentVersion?: string;
  } = {},
): Promise<DoctorReport> {
  const platform = opts.platform ?? process.platform;
  const checks: DoctorCheckItem[] = [];

  // 1. Node.js version
  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split('.')[0] ?? 0);
  if (major >= 24) {
    checks.push({
      id: 'node',
      label: 'Node.js runtime',
      status: 'pass',
      detail: `v${nodeVersion}${major >= 26 ? ' (LTS)' : ' (Node 26 LTS recommended)'}`,
    });
  } else {
    checks.push({
      id: 'node',
      label: 'Node.js runtime',
      status: 'fail',
      detail: `v${nodeVersion} is below the minimum supported version (Node 24+).`,
      fix: 'Install Node.js 26 LTS from https://nodejs.org or run `nvm install 26`.',
    });
  }

  // 2. git binary
  const gitPath = await runner.which('git');
  if (gitPath) {
    const ver = await runner
      .run(gitPath, ['--version'], { cwd: os.tmpdir(), timeoutMs: 5000 })
      .catch(() => null);
    checks.push({
      id: 'git',
      label: 'Git',
      status: 'pass',
      detail: `${ver?.stdout.trim() || 'git'} (${gitPath})`,
    });
  } else {
    checks.push({
      id: 'git',
      label: 'Git',
      status: 'fail',
      detail: 'git binary not found in PATH.',
      fix:
        platform === 'darwin'
          ? 'Run `xcode-select --install` or `brew install git`.'
          : 'Install git with your package manager, e.g. `sudo apt install git`.',
    });
  }

  // 3. Sandbox engine
  const sandbox = await detectSandboxEngine(runner, platform);
  if (sandbox.engine === 'bwrap') {
    checks.push({
      id: 'sandbox',
      label: 'Sandbox (bubblewrap)',
      status: 'pass',
      detail: `bwrap ready (${sandbox.binaryPath})`,
    });
    const dbusProxy = await runner.which('xdg-dbus-proxy');
    checks.push({
      id: 'xdg-dbus-proxy',
      label: 'xdg-dbus-proxy (for Antigravity)',
      status: dbusProxy ? 'pass' : 'warn',
      detail: dbusProxy
        ? `Available (${dbusProxy})`
        : 'Not installed (only needed if you enable Antigravity in the sandbox).',
      ...(dbusProxy
        ? {}
        : { fix: 'Install xdg-dbus-proxy if you use agy: `sudo apt install xdg-dbus-proxy`.' }),
    });
  } else if (sandbox.engine === 'sandbox-exec') {
    checks.push({
      id: 'sandbox',
      label: 'Sandbox (macOS sandbox-exec)',
      status: 'pass',
      detail: `sandbox-exec ready (${sandbox.binaryPath})`,
    });
  } else if (sandbox.engine === 'windows-mxc') {
    checks.push({
      id: 'sandbox',
      label: 'Sandbox (Windows MXC)',
      status: 'pass',
      detail: `Windows confinement checks passed (${sandbox.binaryPath})`,
    });
  } else {
    checks.push({
      id: 'sandbox',
      label: 'Sandbox confinement',
      status: 'warn',
      detail:
        platform === 'win32'
          ? 'Windows MXC is unavailable or did not pass confinement checks; runs require unconfined opt-in.'
          : `No sandbox binary found on ${platform}. Runs require unconfined opt-in.`,
      fix:
        platform === 'linux'
          ? 'Install bubblewrap: `sudo apt install bubblewrap` (Debian/Ubuntu) or `sudo dnf install bubblewrap` (Fedora).'
          : platform === 'win32'
            ? 'Run DALANG inside WSL 2 (Ubuntu) with bubblewrap installed.'
            : 'Ensure `/usr/bin/sandbox-exec` is available on macOS.',
    });
  }

  // 4. Data directory (~/.dalang)
  const dataDir = opts.dataDir ?? getDalangHome();
  try {
    ensureDir(dataDir);
    const probe = path.join(dataDir, `.doctor-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    checks.push({
      id: 'data-dir',
      label: 'Data directory',
      status: 'pass',
      detail: `Writable (${dataDir})`,
    });
  } catch (err) {
    checks.push({
      id: 'data-dir',
      label: 'Data directory',
      status: 'fail',
      detail: `Cannot write to ${dataDir}: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Ensure "${dataDir}" is writable or set DALANG_HOME to a writable folder.`,
    });
  }

  // 5. Terminal room (TTY)
  const isInteractiveTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  checks.push({
    id: 'terminal',
    label: 'Terminal room (TTY)',
    status: isInteractiveTty ? 'pass' : 'warn',
    detail: isInteractiveTty
      ? `Interactive TTY ready (${cols ?? '?'}x${rows ?? '?'}, TERM=${process.env.TERM || 'unknown'})`
      : 'Non-interactive stdin/stdout: `dalang` will start `dalang web` instead of the terminal room.',
  });

  // 6. GitHub CLI (optional, for push + PR)
  const ghPath = await runner.which('gh');
  checks.push({
    id: 'gh',
    label: 'GitHub CLI (optional, for PRs)',
    status: ghPath ? 'pass' : 'warn',
    detail: ghPath ? `Installed (${ghPath})` : 'Not installed (only needed for opening PRs after merge).',
    ...(ghPath
      ? {}
      : { fix: 'Install gh from https://cli.github.com and run `gh auth login`.' }),
  });

  // 6. Agent CLIs (claude, codex, agy)
  const registry = new ProviderRegistry(runner);
  const statuses = await registry.checkAllStatuses();
  let readyCliCount = 0;

  const loginHint: Record<string, { install: string; login: string }> = {
    'claude-code': {
      install: 'Install Claude Code: `npm install -g @anthropic-ai/claude-code`.',
      login: 'Run `claude auth login` to sign in.',
    },
    codex: {
      install: 'Install Codex CLI: `npm install -g @openai/codex`.',
      login: 'Run `codex login` to sign in.',
    },
    antigravity: {
      install: 'Install Antigravity CLI (`agy`) from the Antigravity installer.',
      login: 'Run `agy` interactively once to sign in.',
    },
  };

  for (const st of statuses) {
    const hints = loginHint[st.id];
    if (!st.installed) {
      checks.push({
        id: `cli-${st.id}`,
        label: `${st.displayName} (${st.binary})`,
        status: 'warn',
        detail: 'Not installed in PATH.',
        fix: hints.install,
      });
    } else if (!st.loggedIn) {
      checks.push({
        id: `cli-${st.id}`,
        label: `${st.displayName} (${st.binary})`,
        status: 'warn',
        detail: `Installed (${st.version ?? st.binaryPath}), but not logged in: ${st.authSummary}`,
        fix: hints.login,
      });
    } else {
      readyCliCount += 1;
      checks.push({
        id: `cli-${st.id}`,
        label: `${st.displayName} (${st.binary})`,
        status: 'pass',
        detail: `${st.version ?? 'installed'} · ${st.authSummary} · ${st.models.length} model(s)`,
      });
    }
  }

  if (readyCliCount === 0) {
    checks.push({
      id: 'cli-any',
      label: 'Ready agent CLI',
      status: 'fail',
      detail: 'None of claude, codex, or agy is installed and logged in.',
      fix: 'Install and sign in to at least one CLI (`claude auth login`, `codex login`, or `agy`).',
    });
  }

  const currentVersion = opts.currentVersion ?? DALANG_VERSION;
  let latestVersion: string | null = null;
  let updateAvailable = false;

  if (opts.checkUpdates ?? updateCheckEnabled(dataDir)) {
    const fetcher = opts.updateFetcher ?? (() => fetchLatestNpmVersion(2500));
    try {
      latestVersion = await fetcher();
      if (latestVersion && compareSemver(latestVersion, currentVersion) > 0) {
        updateAvailable = true;
        checks.push({
          id: 'update',
          label: 'DALANG version',
          status: 'warn',
          detail: `v${currentVersion} installed; v${latestVersion} is available on npm.`,
          fix: 'Run `npx dalang-cli@latest` or `npm install -g dalang-cli@latest`.',
        });
      }
    } catch {
      // Offline or unreachable registry: fail silently.
    }
  }

  const ok = !checks.some((c) => c.status === 'fail');
  return { ok, platform, nodeVersion, version: currentVersion, latestVersion, updateAvailable, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `DALANG Doctor v${report.version} (platform=${report.platform}, node=v${report.nodeVersion})`,
    '',
  ];
  for (const item of report.checks) {
    const tag =
      item.status === 'pass' ? '[PASS]' : item.status === 'warn' ? '[WARN]' : '[FAIL]';
    lines.push(`${tag} ${item.label}: ${item.detail}`);
    if (item.fix) {
      lines.push(`       Fix: ${item.fix}`);
    }
  }
  lines.push('');
  lines.push(
    report.ok
      ? 'Ready to run DALANG. Start with `npx dalang-cli`.\nUse `npx dalang-cli web` (or `dalang web`) for the browser UI.\nTo use `dalang` directly, install globally with `npm install -g dalang-cli`.'
      : 'One or more required checks failed. Apply the fixes above and rerun `npx dalang-cli doctor` (or `dalang doctor` after a global install).',
  );
  return lines.join('\n');
}
