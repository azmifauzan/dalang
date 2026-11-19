import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderId, SandboxEngine } from '@dalang/shared';
import type { CliRunner, RunCommandOptions, RunCommandResult } from './types.js';

export function buildPathEnv(extraEnv?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const home = os.homedir();
  const existingPath = process.env.PATH ?? '';
  const extraPaths = [
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  // The user's PATH wins so CLI shebangs (`env node`) resolve to the Node they installed.
  const mergedPath = [...new Set([...existingPath.split(':').filter(Boolean), ...extraPaths])].join(':');
  return {
    ...process.env,
    ...extraEnv,
    PATH: mergedPath,
  };
}

export class NodeCliRunner implements CliRunner {
  async which(binary: string): Promise<string | null> {
    const env = buildPathEnv();
    const pathEntries = (env.PATH ?? '').split(':').filter(Boolean);
    for (const dir of pathEntries) {
      const candidate = path.join(dir, binary);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
    return null;
  }

  run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        idleTimedOut: false,
        aborted: true,
      });
    }

    return new Promise((resolve, reject) => {
      const useStdinPipe = options.stdinData !== undefined || Boolean(options.interactiveStdin);
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: buildPathEnv(options.env),
        stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutRemainder = '';
      let stderrRemainder = '';
      let timedOut = false;
      let idleTimedOut = false;
      let aborted = false;
      let settled = false;

      const totalMs = options.timeoutMs ?? 600_000;
      const idleMs = options.idleTimeoutMs ?? 180_000;

      let idleTimer: NodeJS.Timeout | null = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleMs > 0) {
          idleTimer = setTimeout(() => {
            idleTimedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2000).unref();
          }, idleMs);
        }
      };

      const totalTimer =
        totalMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 2000).unref();
            }, totalMs)
          : null;

      const onAbort = () => {
        aborted = true;
        if (!settled) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 2000).unref();
        }
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanupTimers = () => {
        if (totalTimer) clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      resetIdle();

      const flushLines = (chunk: string, isStderr: boolean) => {
        if (isStderr) {
          stderrRemainder += chunk;
          const parts = stderrRemainder.split(/\r?\n/);
          stderrRemainder = parts.pop() ?? '';
          for (const line of parts) options.onStderrLine?.(line);
        } else {
          stdoutRemainder += chunk;
          const parts = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = parts.pop() ?? '';
          for (const line of parts) options.onStdoutLine?.(line);
        }
      };

      child.stdout?.on('data', (buf: Buffer) => {
        resetIdle();
        const text = buf.toString('utf8');
        stdout += text;
        flushLines(text, false);
      });

      child.stderr?.on('data', (buf: Buffer) => {
        resetIdle();
        const text = buf.toString('utf8');
        stderr += text;
        flushLines(text, true);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        reject(err);
      });

      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        if (stdoutRemainder) options.onStdoutLine?.(stdoutRemainder);
        if (stderrRemainder) options.onStderrLine?.(stderrRemainder);
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          idleTimedOut,
          aborted,
        });
      });

      if (options.onSpawn && child.stdin) {
        options.onSpawn({
          writeStdin: (data: string) => {
            if (!child.stdin?.writableEnded) {
              child.stdin?.write(data);
            }
          },
          endStdin: () => {
            if (!child.stdin?.writableEnded) {
              child.stdin?.end();
            }
          },
          kill: () => {
            if (!settled) child.kill('SIGTERM');
          },
        });
      }

      if (options.stdinData !== undefined && child.stdin) {
        child.stdin.write(options.stdinData);
        child.stdin.end();
      }
    });
  }
}

export interface BwrapInvocation {
  command: string;
  args: string[];
  sandboxed: boolean;
  engine?: SandboxEngine;
}

export interface SandboxWrapOptions {
  dbusSocket?: string;
  readOnly?: boolean;
  bindProviderDirs?: boolean;
  configDir?: string | null;
  platform?: NodeJS.Platform;
}

const PROVIDER_STATE_DIRS: Record<ProviderId, string[]> = {
  'claude-code': ['.claude', '.claude.json'],
  codex: ['.codex'],
  antigravity: ['.gemini'],
};

const MASKED_CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.config/gcloud'] as const;
const MASKED_CREDENTIAL_FILES = ['.git-credentials', '.netrc'] as const;

export function normalizeConfigDir(configDir?: string | null): string | null {
  const trimmed = configDir?.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.resolve(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

/**
 * Environment variables that direct a CLI to a profile-specific account directory.
 */
export function buildProviderAccountEnv(
  provider: ProviderId,
  configDir?: string | null,
): Record<string, string | undefined> {
  const resolved = normalizeConfigDir(configDir);
  if (!resolved) return {};
  if (provider === 'claude-code') {
    return { CLAUDE_CONFIG_DIR: resolved };
  }
  if (provider === 'codex') {
    return { CODEX_HOME: resolved };
  }
  return {
    AGY_CONFIG_DIR: resolved,
    XDG_CONFIG_HOME: resolved,
  };
}

export async function findBwrap(
  runner: CliRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== 'linux') return null;
  return runner.which('bwrap');
}

export async function findSandboxExec(
  runner: CliRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== 'darwin') return null;
  const fromPath = await runner.which('sandbox-exec');
  if (fromPath) return fromPath;
  return fs.existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : null;
}

export async function detectSandboxEngine(
  runner: CliRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ engine: SandboxEngine; binaryPath: string | null }> {
  if (platform === 'linux') {
    const bwrapPath = await findBwrap(runner, platform);
    return bwrapPath ? { engine: 'bwrap', binaryPath: bwrapPath } : { engine: 'none', binaryPath: null };
  }
  if (platform === 'darwin') {
    const sbPath = await findSandboxExec(runner, platform);
    return sbPath ? { engine: 'sandbox-exec', binaryPath: sbPath } : { engine: 'none', binaryPath: null };
  }
  return { engine: 'none', binaryPath: null };
}

export interface DbusProxy {
  socketPath: string;
  stop: () => void;
}

/**
 * agy signs in through the desktop keyring over the session bus. The bus can also start units outside
 * the sandbox, so the run gets a filtered proxy that only allows the secrets service.
 */
export async function startDbusProxy(runner: CliRunner): Promise<DbusProxy | null> {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? '';
  const proxyBinary = await runner.which('xdg-dbus-proxy');
  if (!proxyBinary || !address.startsWith('unix:')) return null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-bus-'));
  const socketPath = path.join(dir, 'bus');
  const child = spawn(proxyBinary, [address, socketPath, '--filter', '--talk=org.freedesktop.secrets'], {
    stdio: 'ignore',
  });
  const stop = () => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 3000;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      stop();
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { socketPath, stop };
}

function escapeSbpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a macOS Seatbelt (SBPL) profile with the same confinement guarantees as `bwrap`:
 * - Deny writes everywhere by default; allow writes only to projectPath (unless readOnly), temp dirs, /dev/null,
 *   and the active provider state/config directory.
 * - Deny writes to `.git/hooks` or a worktree `.git` link file.
 * - Deny reading credential directories and files (`~/.ssh`, `~/.gnupg`, `~/.aws`, etc.).
 */
export function buildMacOsSeatbeltProfile(
  provider: ProviderId | null,
  projectPath: string,
  options: SandboxWrapOptions = {},
): string {
  const home = os.homedir();
  const resolvedProject = path.resolve(projectPath);
  const rules: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    '(allow file-write* (subpath "/tmp") (subpath "/private/tmp") (subpath "/private/var/folders"))',
  ];

  const tmpDir = os.tmpdir();
  if (tmpDir && tmpDir !== '/tmp' && tmpDir !== '/private/tmp') {
    rules.push(`(allow file-write* (subpath "${escapeSbpl(tmpDir)}"))`);
  }

  if (!options.readOnly) {
    rules.push(`(allow file-write* (subpath "${escapeSbpl(resolvedProject)}"))`);
  }

  if (provider && options.bindProviderDirs !== false) {
    const customConfig = normalizeConfigDir(options.configDir);
    if (customConfig) {
      rules.push(`(allow file-write* (subpath "${escapeSbpl(customConfig)}"))`);
    } else {
      for (const rel of PROVIDER_STATE_DIRS[provider]) {
        const abs = path.join(home, rel);
        rules.push(`(allow file-write* (subpath "${escapeSbpl(abs)}") (literal "${escapeSbpl(abs)}"))`);
      }
    }
  }

  // Mask credential folders and files from agent reads, matching bwrap.
  for (const rel of MASKED_CREDENTIAL_DIRS) {
    const abs = path.join(home, rel);
    if (!resolvedProject.startsWith(abs + path.sep)) {
      rules.push(`(deny file-read* (subpath "${escapeSbpl(abs)}"))`);
    }
  }
  for (const rel of MASKED_CREDENTIAL_FILES) {
    const abs = path.join(home, rel);
    rules.push(`(deny file-read* (literal "${escapeSbpl(abs)}"))`);
  }

  // Prevent sandboxed agents from writing `.git/hooks` or tampering with a worktree `.git` file.
  const dotGit = path.join(resolvedProject, '.git');
  if (!options.readOnly && fs.existsSync(dotGit)) {
    const stat = fs.lstatSync(dotGit);
    if (stat.isFile() || stat.isSymbolicLink()) {
      rules.push(`(deny file-write* (literal "${escapeSbpl(dotGit)}"))`);
    } else if (stat.isDirectory()) {
      rules.push(`(deny file-write* (subpath "${escapeSbpl(path.join(dotGit, 'hooks'))}"))`);
    }
  }

  return rules.join('\n');
}

export async function wrapWithSandboxExec(
  runner: CliRunner,
  provider: ProviderId | null,
  projectPath: string,
  command: string,
  args: string[],
  options: SandboxWrapOptions = {},
): Promise<BwrapInvocation> {
  const platform = options.platform ?? process.platform;
  const sbPath = await findSandboxExec(runner, platform);
  if (!sbPath) {
    return { command, args, sandboxed: false, engine: 'none' };
  }

  const customConfig = normalizeConfigDir(options.configDir);
  if (customConfig && !fs.existsSync(customConfig)) {
    fs.mkdirSync(customConfig, { recursive: true });
  }

  const profile = buildMacOsSeatbeltProfile(provider, projectPath, options);
  return {
    command: sbPath,
    args: ['-p', profile, command, ...args],
    sandboxed: true,
    engine: 'sandbox-exec',
  };
}

export async function wrapWithBwrap(
  runner: CliRunner,
  provider: ProviderId | null,
  projectPath: string,
  command: string,
  args: string[],
  options: SandboxWrapOptions = {},
): Promise<BwrapInvocation> {
  const platform = options.platform ?? process.platform;
  const bwrapPath = await findBwrap(runner, platform);
  if (!bwrapPath) {
    return { command, args, sandboxed: false, engine: 'none' };
  }

  const home = os.homedir();
  const projectBindFlag = options.readOnly ? '--ro-bind' : '--bind';
  const bwrapArgs: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    projectBindFlag,
    projectPath,
    projectPath,
  ];

  // Keep user-session and container sockets out of reach (a socket there lets a run act outside the sandbox).
  // The only bus a run may see is a filtered proxy socket, mounted where the CLI expects the session bus.
  if (fs.existsSync('/run/user')) bwrapArgs.push('--tmpfs', '/run/user');
  if (options.dbusSocket && typeof process.getuid === 'function') {
    const busPath = `/run/user/${process.getuid()}/bus`;
    bwrapArgs.push('--ro-bind', options.dbusSocket, busPath, '--setenv', 'DBUS_SESSION_BUS_ADDRESS', `unix:path=${busPath}`);
  }
  const dockerSock = '/run/docker.sock'; // /var/run is a symlink to /run on Linux
  if (fs.existsSync(dockerSock)) bwrapArgs.push('--ro-bind', '/dev/null', dockerSock);

  // Credentials no agent run needs; DALANG itself does the git pushing and signing.
  // ~/.npmrc stays visible on purpose: private-registry installs need its token.
  for (const rel of MASKED_CREDENTIAL_DIRS) {
    const abs = path.join(home, rel);
    if (fs.existsSync(abs) && !projectPath.startsWith(abs + path.sep)) {
      bwrapArgs.push('--tmpfs', abs);
    }
  }
  for (const rel of MASKED_CREDENTIAL_FILES) {
    const abs = path.join(home, rel);
    if (fs.existsSync(abs)) bwrapArgs.push('--ro-bind', '/dev/null', abs);
  }

  if (provider && options.bindProviderDirs !== false) {
    const customConfig = normalizeConfigDir(options.configDir);
    if (customConfig) {
      if (!fs.existsSync(customConfig)) {
        fs.mkdirSync(customConfig, { recursive: true });
      }
      bwrapArgs.push('--bind', customConfig, customConfig);
      for (const [envKey, envVal] of Object.entries(buildProviderAccountEnv(provider, customConfig))) {
        if (envVal) bwrapArgs.push('--setenv', envKey, envVal);
      }
    } else {
      for (const rel of PROVIDER_STATE_DIRS[provider]) {
        const abs = path.join(home, rel);
        if (fs.existsSync(abs)) {
          bwrapArgs.push('--bind', abs, abs);
        }
      }
    }
  }

  // Prevent sandboxed agents from writing executable hooks into `.git/hooks` or tampering with a worktree `.git` link file.
  const dotGit = path.join(projectPath, '.git');
  if (!options.readOnly && fs.existsSync(dotGit)) {
    const stat = fs.lstatSync(dotGit);
    if (stat.isFile() || stat.isSymbolicLink()) {
      bwrapArgs.push('--ro-bind', dotGit, dotGit);
    } else if (stat.isDirectory()) {
      const gitHooksDir = path.join(dotGit, 'hooks');
      if (fs.existsSync(gitHooksDir)) {
        bwrapArgs.push('--ro-bind', gitHooksDir, gitHooksDir);
      }
    }
  }

  bwrapArgs.push('--chdir', projectPath, '--', command, ...args);

  return {
    command: bwrapPath,
    args: bwrapArgs,
    sandboxed: true,
    engine: 'bwrap',
  };
}

/**
 * Cross-platform sandbox wrapper: uses `bwrap` on Linux and `sandbox-exec` on macOS.
 */
export async function wrapWithSandbox(
  runner: CliRunner,
  provider: ProviderId | null,
  projectPath: string,
  command: string,
  args: string[],
  options: SandboxWrapOptions = {},
): Promise<BwrapInvocation> {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') {
    return wrapWithBwrap(runner, provider, projectPath, command, args, options);
  }
  if (platform === 'darwin') {
    return wrapWithSandboxExec(runner, provider, projectPath, command, args, options);
  }
  return { command, args, sandboxed: false, engine: 'none' };
}
