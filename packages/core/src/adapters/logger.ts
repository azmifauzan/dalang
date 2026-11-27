import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface TurnLoggerOptions {
  /** Prefix every written line with an ISO-8601 timestamp (default: true). */
  timestamps?: boolean;
  /** Optional clock override for deterministic tests. */
  now?: () => Date;
  /** Optional hook called when an async filesystem operation fails. */
  onError?: (error: unknown) => void;
}

export interface TurnLogger {
  write: (line: string) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s/;

export function formatLogLineWithTimestamp(line: string, now: () => Date = () => new Date()): string {
  if (ISO_PREFIX_RE.test(line)) return line;
  return `${now().toISOString()} ${line}`;
}

export function stripLogLineTimestamp(line: string): string {
  return line.replace(ISO_PREFIX_RE, '');
}

export function redactSecrets(text: string, secrets?: readonly (string | null | undefined)[]): string {
  if (!secrets || secrets.length === 0 || !text) return text;
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

export function createTurnLogger(
  logFilePath?: string,
  secrets?: readonly (string | null | undefined)[],
  options: TurnLoggerOptions = {},
): TurnLogger {
  if (!logFilePath) {
    return {
      write: () => {},
      flush: async () => {},
      close: async () => {},
    };
  }

  const timestamps = options.timestamps ?? true;
  const now = options.now ?? (() => new Date());
  const queue: string[] = [];
  let closed = false;
  let failed = false;
  let dirEnsured = false;
  let drainPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;

  const reportError = (err: unknown) => {
    failed = true;
    queue.length = 0;
    try {
      options.onError?.(err);
    } catch {
      // ignore error hook failures
    }
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0 && !failed) {
      let fh: fsp.FileHandle | null = null;
      try {
        if (!dirEnsured) {
          await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
          dirEnsured = true;
        }
        // O_NOFOLLOW: a symlink planted at the log path fails instead of redirecting the append.
        fh = await fsp.open(
          logFilePath,
          fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
          0o644,
        );
        while (queue.length > 0 && !failed) {
          const batch = queue.splice(0, queue.length).join('');
          if (!batch) continue;
          await fh.write(batch, undefined, 'utf8');
        }
      } catch (err) {
        reportError(err);
        break;
      } finally {
        if (fh) {
          try {
            await fh.close();
          } catch (err) {
            reportError(err);
          }
        }
      }
    }
  };

  const scheduleDrain = (): Promise<void> => {
    if (!drainPromise) {
      drainPromise = drain().finally(() => {
        drainPromise = null;
        if (queue.length > 0 && !failed) {
          void scheduleDrain();
        }
      });
    }
    return drainPromise;
  };

  const flush = async (): Promise<void> => {
    while ((drainPromise || queue.length > 0) && !failed) {
      await scheduleDrain();
    }
  };

  return {
    write: (line: string) => {
      if (closed || failed) return;
      const safe = redactSecrets(line, secrets);
      const formatted = timestamps ? formatLogLineWithTimestamp(safe, now) : safe;
      queue.push(`${formatted}\n`);
      void scheduleDrain();
    },
    flush,
    close: () => {
      closed = true;
      if (closePromise) return closePromise;
      closePromise = flush();
      return closePromise;
    },
  };
}
