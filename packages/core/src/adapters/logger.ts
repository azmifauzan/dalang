import fs from 'node:fs';
import path from 'node:path';

export interface TurnLogger {
  write: (line: string) => void;
  close: () => void;
}

export function createTurnLogger(logFilePath?: string): TurnLogger {
  if (!logFilePath) {
    return {
      write: () => {},
      close: () => {},
    };
  }

  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const fd = fs.openSync(logFilePath, 'a');
  let closed = false;

  return {
    write: (line: string) => {
      if (closed) return;
      fs.writeSync(fd, `${line}\n`, undefined, 'utf8');
    },
    close: () => {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}
