import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { RecordingCliRunner, type CliRecording } from '../testing/recording-runner.js';

const TOKEN = 'secret-token-1234567890';

class FakeRunner implements CliRunner {
  readonly supportsInteractiveStdin = true;
  calls: string[] = [];
  async which(binary: string) {
    return `/usr/bin/${binary}`;
  }
  async run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult> {
    this.calls.push(command);
    options.onSpawn?.({ writeStdin: () => {}, endStdin: () => {}, kill: () => {} });
    options.onStdoutLine?.('{"type":"system"}');
    options.onStdoutLine?.(`{"type":"result","token":"${TOKEN}"}`);
    options.onStderrLine?.('warn');
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
  }
}

async function readRecordings(dir: string): Promise<CliRecording[]> {
  await vi.waitFor(() => expect(fs.existsSync(dir) && fs.readdirSync(dir).length).toBeTruthy());
  return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CliRecording);
}

describe('RecordingCliRunner', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records a sandboxed provider turn as a replay entry with timings, stdin, and redacted secrets', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-rec-'));
    const inner = new FakeRunner();
    const runner = new RecordingCliRunner(inner, path.join(dir, 'rec'));
    expect(runner.supportsInteractiveStdin).toBe(true);

    const seen: string[] = [];
    let writeStdin: ((data: string) => void) | undefined;
    await runner.run('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--', '/usr/bin/claude', '-p', 'hello there', '--model', 'opus'], {
      cwd: '/repo',
      env: { DALANG_MCP_TOKEN: TOKEN, HOME: '/home/x' },
      onStdoutLine: (line) => seen.push(line),
      onSpawn: (controls) => {
        writeStdin = controls.writeStdin;
      },
    });
    writeStdin?.(`steer ${TOKEN}`);

    // The caller still gets the raw lines; only the saved copy is redacted.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(TOKEN);

    const [rec] = await readRecordings(path.join(dir, 'rec'));
    expect(rec.provider).toBe('claude-code');
    expect(rec.command).toBe('claude');
    expect(rec.match).toEqual({ provider: 'claude-code', model: 'opus' });
    expect(rec.promptHead).toBe('hello there');
    expect(rec.stdoutLines).toHaveLength(2);
    expect(rec.stdoutTimesMs).toHaveLength(2);
    expect(rec.firstStdoutMs).not.toBeNull();
    expect(rec.stderrLines).toEqual(['warn']);
    expect(rec.exitCode).toBe(0);
    expect(JSON.stringify(rec)).not.toContain(TOKEN);
    expect(fs.statSync(path.join(dir, 'rec', fs.readdirSync(path.join(dir, 'rec'))[0])).mode & 0o777).toBe(0o600);
  });

  it('passes non-provider commands through without recording', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-rec-'));
    const inner = new FakeRunner();
    const runner = new RecordingCliRunner(inner, path.join(dir, 'rec'));
    await runner.run('/usr/bin/git', ['status'], { cwd: '/repo' });
    expect(inner.calls).toEqual(['/usr/bin/git']);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(dir, 'rec'))).toBe(false);
  });
});
