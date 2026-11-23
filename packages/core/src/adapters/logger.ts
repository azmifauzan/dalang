import fs from 'node:fs';
import path from 'node:path';

export interface TurnLogger {
  write: (line: string) => void;
  close: () => void;
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
): TurnLogger {
  if (!logFilePath) {
    return {
      write: () => {},
      close: () => {},
    };
  }

  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  // O_NOFOLLOW: a symlink planted at the log path fails instead of redirecting the append.
  const fd = fs.openSync(
    logFilePath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o644,
  );
  let closed = false;

  return {
    write: (line: string) => {
      if (closed) return;
      fs.writeSync(fd, `${redactSecrets(line, secrets)}\n`, undefined, 'utf8');
    },
    close: () => {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}
