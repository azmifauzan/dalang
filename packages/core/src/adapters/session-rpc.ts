import type { CliRunner, RunCommandOptions } from './types.js';

type Json = Record<string, unknown>;

export function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
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
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (reason: Error) => void }>();
  function send(message: Json) {
    if (!controls || closed) throw new Error('Provider session is closed.');
    controls.writeStdin(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  let ready!: () => void;
  const spawned = new Promise<void>((resolve) => { ready = resolve; });
  const processResult = runner.run(command, args, {
    ...options,
    interactiveStdin: true,
    onSpawn: (next) => { controls = next; ready(); },
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
          if (!closed) send(result
            ? { id: message.id, result }
            : { id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
        } else {
          onNotification(message.method, params);
        }
      } else if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        const error = object(message.error);
        if (message.error) request.reject(new SessionRpcError(String(error.message ?? 'Provider request failed.'), error.code));
        else request.resolve(object(message.result));
      }
    },
  });
  try {
    return await Promise.race([
      processResult.then((result): never => {
        throw new Error(result.aborted ? 'Provider session was stopped.'
          : result.idleTimedOut || result.timedOut ? 'Provider session timed out.'
          : `Provider session exited (${result.exitCode}). ${result.stderr.slice(-1000)}`);
      }),
      spawned.then(() => run({
        request(method, params) {
          const id = ++sequence;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send({ id, method, params });
          });
        },
        notify(method, params) { send({ method, params }); },
      })),
    ]);
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
