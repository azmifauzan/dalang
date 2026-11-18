import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderId } from '@dalang/shared';
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
}

const PROVIDER_STATE_DIRS: Record<ProviderId, string[]> = {
  'claude-code': ['.claude', '.claude.json'],
  codex: ['.codex'],
  antigravity: ['.gemini'],
};

export async function findBwrap(runner: CliRunner): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  return runner.which('bwrap');
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

export async function wrapWithBwrap(
  runner: CliRunner,
  provider: ProviderId | null,
  projectPath: string,
  command: string,
  args: string[],
  options: { dbusSocket?: string; readOnly?: boolean; bindProviderDirs?: boolean } = {},
): Promise<BwrapInvocation> {
  const bwrapPath = await findBwrap(runner);
  if (!bwrapPath) {
    return { command, args, sandboxed: false };
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
  for (const rel of ['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.config/gcloud']) {
    const abs = path.join(home, rel);
    if (fs.existsSync(abs) && !projectPath.startsWith(abs + path.sep)) {
      bwrapArgs.push('--tmpfs', abs);
    }
  }
  for (const rel of ['.git-credentials', '.netrc']) {
    const abs = path.join(home, rel);
    if (fs.existsSync(abs)) bwrapArgs.push('--ro-bind', '/dev/null', abs);
  }

  if (provider && options.bindProviderDirs !== false) {
    for (const rel of PROVIDER_STATE_DIRS[provider]) {
      const abs = path.join(home, rel);
      if (fs.existsSync(abs)) {
        bwrapArgs.push('--bind', abs, abs);
      }
    }
  }

  // Prevent sandboxed agents from writing executable hooks into `.git/hooks`.
  const gitHooksDir = path.join(projectPath, '.git', 'hooks');
  if (!options.readOnly && fs.existsSync(gitHooksDir)) {
    bwrapArgs.push('--ro-bind', gitHooksDir, gitHooksDir);
  }

  bwrapArgs.push('--chdir', projectPath, '--', command, ...args);

  return {
    command: bwrapPath,
    args: bwrapArgs,
    sandboxed: true,
  };
}
