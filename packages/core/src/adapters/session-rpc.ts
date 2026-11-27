import type { CliRunner, RunCommandOptions } from './types.js';
import { redactSecrets } from './logger.js';

class ErrorWithStderr extends Error {}
export class FatalStderrError extends ErrorWithStderr {}

export function stderrTail(text: string, secrets?: readonly (string | null | undefined)[]): string {
  let safe = redactSecrets(text, secrets);
  for (const secret of secrets ?? []) if (secret) safe = safe.split(secret).join('[REDACTED]');
  return safe
    .replace(/\b(Bearer\s+)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(
      /([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|key|client_secret|password)=)[^&#\s]+/gi,
      '$1[REDACTED]',
    )
    .slice(-4000)
    .trim();
}

export function turnRunner(
  runner: CliRunner,
  provider: 'codex' | 'claude' | 'antigravity',
  secrets?: readonly (string | null | undefined)[],
  engine?: string,
): CliRunner {
  // B1's original host restriction remains unknown from the available stderr.
  const patterns: Record<typeof provider, Array<[RegExp, string]>> = {
    codex: [
      [
        /^Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces(?=\r?$)/im,
        'Codex cannot create a user namespace. Check whether user namespace restrictions or AppArmor policy are responsible.',
      ],
    ],
    claude: [],
    antigravity: [],
  };
  const common: Array<[RegExp, string]> = [
    [
      /^bwrap:.*(?:No permissions to create a new namespace|Operation not permitted.*namespace)/im,
      'Bubblewrap cannot create a namespace. Check whether user namespace restrictions or AppArmor policy are responsible.',
    ],
    [
      /^bwrap:.*(?:Unknown option|unrecognized option)/im,
      engine === 'bwrap'
        ? 'DALANG bubblewrap configuration is not supported by the installed bwrap. Update bubblewrap or check the sandbox configuration.'
        : 'A bubblewrap option is unsupported; its origin is unconfirmed. Check the bwrap version and configuration.',
    ],
  ];
  return {
    supportsInteractiveStdin: runner.supportsInteractiveStdin,
    which: (binary) => runner.which(binary),
    run: async (command, args, options) => {
      let controls: Parameters<NonNullable<RunCommandOptions['onSpawn']>>[0] | undefined;
      let fatal: string | undefined;
      let recent = '';
      let rejectFatal!: (error: Error) => void;
      const failed = new Promise<never>((_, reject) => {
        rejectFatal = reject;
      });
      const check = (value: string) => {
        const match = [...patterns[provider], ...common].find(([pattern]) => pattern.test(value));
        if (match && !fatal) {
          fatal = `${match[1]}\nStderr: ${stderrTail(value, secrets)}`;
          controls?.kill();
          rejectFatal(new FatalStderrError(fatal));
        }
      };
      const proc = runner.run(command, args, {
        ...options,
        onSpawn: (next) => {
          controls = next;
          options.onSpawn?.(next);
          if (fatal) next.kill();
        },
        onStderrChunk: (chunk) => {
          recent = (recent + chunk).slice(-8000);
          check(recent);
          options.onStderrChunk?.(chunk);
        },
        onStderrLine: (line) => {
          options.onStderrLine?.(stderrTail(line, secrets));
          check(line);
        },
      });
      // Prevent unhandled rejection if failed wins before proc settles
      proc.catch(() => undefined);
      const result = await Promise.race([proc, failed]);
      const tail = stderrTail(result.stderr, secrets);
      if (!result.aborted && (result.timedOut || result.idleTimedOut)) {
        throw new ErrorWithStderr(
          `Provider turn timed out (${result.idleTimedOut ? 'idle' : 'total'}).${tail ? `\nStderr: ${tail}` : ''}`,
        );
      }
      return { ...result, stderr: tail };
    },
  };
}

type Json = Record<string, unknown>;

export function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

export class SessionRpcError extends Error {
  constructor(message: string, readonly code: unknown) {
    super(message);
  }
}

interface SessionRpc {
  request(method: string, params?: Json): Promise<Json>;
  notify(method: string, params?: Json): void;
}

export async function withSessionRpc<T>(
  runner: CliRunner,
  command: string,
  args: string[],
  options: RunCommandOptions,
  onNotification: (method: string, params: Json) => void,
  run: (rpc: SessionRpc) => Promise<T>,
  onRequest?: (method: string, params: Json) => Json | undefined,
): Promise<T> {
  let sequence = 0;
  let controls: Parameters<NonNullable<RunCommandOptions['onSpawn']>>[0] | undefined;
  let closed = false;
  let stderr = '';
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (reason: Error) => void }>();
  function send(message: Json) {
    if (!controls || closed) throw new Error('Provider session is closed.');
    controls.writeStdin(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  let ready!: () => void;
  const spawned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const processResult = runner.run(command, args, {
    ...options,
    interactiveStdin: true,
    onSpawn: (next) => {
      controls = next;
      ready();
    },
    onStderrLine: (line) => {
      stderr = (stderr + line + '\n').slice(-4000);
      options.onStderrLine?.(line);
    },
    onStdoutLine: (line) => {
      let message: Json;
      try {
        message = object(JSON.parse(line));
      } catch {
        return;
      }
      if (typeof message.method === 'string') {
        const params = object(message.params);
        if (typeof message.id === 'number' || typeof message.id === 'string') {
          const result = onRequest?.(message.method, params);
          if (!closed) {
            send(
              result
                ? { id: message.id, result }
                : { id: message.id, error: { code: -32601, message: 'Unsupported client request' } },
            );
          }
        } else {
          onNotification(message.method, params);
        }
      } else if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        const error = object(message.error);
        if (message.error) {
          request.reject(new SessionRpcError(String(error.message ?? 'Provider request failed.'), error.code));
        } else {
          request.resolve(object(message.result));
        }
      }
    },
  });
  try {
    return await Promise.race([
      processResult.then((result): never => {
        throw new ErrorWithStderr(
          result.aborted
            ? 'Provider session was stopped.'
            : result.idleTimedOut || result.timedOut
              ? `Provider session timed out.${result.stderr ? ` ${result.stderr}` : ''}`
              : `Provider session exited (${result.exitCode}).${result.stderr ? ` ${result.stderr}` : ''}`,
        );
      }),
      spawned.then(() =>
        run({
          request(method, params) {
            const id = ++sequence;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              send({ id, method, params });
            });
          },
          notify(method, params) {
            send({ method, params });
          },
        }),
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && !(error instanceof ErrorWithStderr) && stderr.trim()) {
      error.message += `\nStderr: ${stderr.trim()}`;
    }
    throw error;
  } finally {
    closed = true;
    for (const request of pending.values()) request.reject(new Error('Provider session is closed.'));
    pending.clear();
    controls?.endStdin();
    const cleanup = setTimeout(() => controls?.kill(), 2000);
    cleanup.unref();
    await processResult.catch(() => undefined);
    clearTimeout(cleanup);
  }
}
