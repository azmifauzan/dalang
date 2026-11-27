import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnLogger, stripLogLineTimestamp } from '../adapters/logger.js';

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

describe('async TurnLogger (R7, P4)', () => {
  it('writes lines asynchronously in strict FIFO order with timestamps and secret redaction, and flushes on close', async () => {
    const dir = makeTempDir('dalang-log-');
    const logPath = path.join(dir, 'nested', 'run.log');
    const secret = 'super-secret-bearer-token-999';
    let tick = 0;
    const logger = createTurnLogger(logPath, [secret], {
      now: () => new Date(1_764_200_000_000 + tick++ * 1000),
    });

    for (let i = 0; i < 40; i++) {
      logger.write(`line-${i} token=${secret}`);
    }
    // Writing is non-blocking; close() waits for every queued line to hit disk.
    await logger.close();
    // Writes after close are ignored.
    logger.write('after-close');
    await logger.close();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(40);
    for (let i = 0; i < 40; i++) {
      expect(lines[i]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(stripLogLineTimestamp(lines[i])).toBe(`line-${i} token=[REDACTED]`);
      expect(lines[i]).not.toContain(secret);
    }
  });

  it('handles I/O errors (such as symlink targets) without throwing unhandled rejections', async () => {
    const dir = makeTempDir('dalang-log-err-');
    const target = path.join(dir, 'outside.txt');
    fs.writeFileSync(target, 'original', 'utf8');
    const symlinkPath = path.join(dir, 'run.log');
    fs.symlinkSync(target, symlinkPath);

    const errors: unknown[] = [];
    const logger = createTurnLogger(symlinkPath, [], {
      onError: (err) => errors.push(err),
    });
    logger.write('should-not-write');
    logger.write('second-line');
    await expect(logger.close()).resolves.toBeUndefined();

    expect(errors.length).toBeGreaterThan(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });
});
