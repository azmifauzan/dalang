import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import { RecordingCliRunner, type CliRecording } from '../testing/recording-runner.js';
import { ReplayCliRunner, type ReplayTranscript, type ReplayTurnEntry } from '../testing/replay-runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_SCRIPT = path.resolve(here, '../../scripts/recordings.mjs');
const TOKEN = 'secret-token-1234567890';

type ReplayScriptEntry =
  | { type: 'expect_outbound'; frame: unknown }
  | { type: 'emit_inbound'; frame: unknown; afterMs?: number }
  | { type: 'exit'; exitCode: number; timedOut?: boolean; idleTimedOut?: boolean; aborted?: boolean };

interface ConvertedTurn extends ReplayTurnEntry {
  entries?: ReplayScriptEntry[];
}

interface RecordingsModule {
  isTurnRecording: (recording: CliRecording | Record<string, unknown>) => boolean;
  reassembleStdinWrites: (rawWrites: Array<{ atMs?: number; data: string }>) => Array<{ atMs?: number; data: string }>;
  convertRecordingToReplayEntries: (recording: CliRecording | Record<string, unknown>) => ReplayScriptEntry[];
  recordingToTranscriptTurn: (recording: CliRecording | Record<string, unknown>) => ConvertedTurn;
  buildTranscriptFromRecordings: (
    recordings: Array<CliRecording | Record<string, unknown>>,
    options?: { name?: string; description?: string; provider?: string | null },
  ) => ReplayTranscript & { turns: ConvertedTurn[] };
}

const {
  buildTranscriptFromRecordings,
  convertRecordingToReplayEntries,
  isTurnRecording,
  reassembleStdinWrites,
  recordingToTranscriptTurn,
} = (await import(pathToFileURL(RECORDINGS_SCRIPT).href)) as RecordingsModule;

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
  return fs
    .readdirSync(dir)
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CliRecording);
}

describe('RecordingCliRunner', () => {
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('records a sandboxed provider turn as a replay entry with timings, stdin, ordered events, and redacted secrets', async () => {
    const dir = makeTempDir('dalang-rec-');
    const inner = new FakeRunner();
    const runner = new RecordingCliRunner(inner, path.join(dir, 'rec'));
    expect(runner.supportsInteractiveStdin).toBe(true);

    const seen: string[] = [];
    let writeStdin: ((data: string) => void) | undefined;
    await runner.run(
      '/usr/bin/bwrap',
      ['--ro-bind', '/', '/', '--', '/usr/bin/claude', '-p', 'hello there', '--model', 'opus'],
      {
        cwd: '/repo',
        env: { DALANG_MCP_TOKEN: TOKEN, HOME: '/home/x' },
        onStdoutLine: (line) => seen.push(line),
        onSpawn: (controls) => {
          writeStdin = controls.writeStdin;
        },
      },
    );
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
    expect(rec.events?.map((e) => e.direction)).toEqual(['stdout', 'stdout', 'stdin']);
    expect(JSON.stringify(rec)).not.toContain(TOKEN);
    expect(fs.statSync(path.join(dir, 'rec', fs.readdirSync(path.join(dir, 'rec'))[0])).mode & 0o777).toBe(0o600);
  });

  it('passes non-provider commands through without recording', async () => {
    const dir = makeTempDir('dalang-rec-');
    const inner = new FakeRunner();
    const runner = new RecordingCliRunner(inner, path.join(dir, 'rec'));
    await runner.run('/usr/bin/git', ['status'], { cwd: '/repo' });
    expect(inner.calls).toEqual(['/usr/bin/git']);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(dir, 'rec'))).toBe(false);
  });

  it('records cross-direction order accurately even when stdin writes and stdout replies happen synchronously in the same millisecond', async () => {
    const dir = makeTempDir('dalang-rec-sync-');
    const recDir = path.join(dir, 'rec');

    const syncProtocolRunner: CliRunner = {
      supportsInteractiveStdin: true,
      async which(binary) {
        return `/usr/bin/${binary}`;
      },
      async run(_command, _args, options) {
        const sendStdout = (obj: unknown) => options.onStdoutLine?.(JSON.stringify(obj));
        options.onSpawn?.({
          writeStdin: (data) => {
            for (const line of data.split(/\r?\n/)) {
              if (!line.trim()) continue;
              const msg = JSON.parse(line) as { id?: number; method?: string };
              if (msg.method === 'initialize') {
                sendStdout({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex' } });
              } else if (msg.method === 'thread/start') {
                sendStdout({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 't-sync' } } });
              }
            }
          },
          endStdin: () => {},
          kill: () => {},
        });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const recorder = new RecordingCliRunner(syncProtocolRunner, recDir);
    let controls: { writeStdin: (data: string) => void } | undefined;
    await recorder.run('/usr/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      onSpawn: (c) => {
        controls = c;
        c.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
      },
      onStdoutLine: (line) => {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id === 1) {
          controls?.writeStdin('{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/repo"}}\n');
        }
      },
    });

    const [rec] = await readRecordings(recDir);
    expect(rec.events?.map((e) => e.direction)).toEqual(['stdin', 'stdout', 'stdin', 'stdout']);

    const entries = convertRecordingToReplayEntries(rec);
    expect(entries).toEqual([
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } } },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: '/repo' } } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 2, result: { thread: { id: 't-sync' } } } },
      { type: 'exit', exitCode: 0 },
    ]);
  });

  it('records stdin_end so an unterminated stdin frame closed before stdout stays ordered before its response', async () => {
    const dir = makeTempDir('dalang-rec-stdin-end-');
    const recDir = path.join(dir, 'rec');

    const eofProtocolRunner: CliRunner = {
      supportsInteractiveStdin: true,
      async which(binary) {
        return `/usr/bin/${binary}`;
      },
      async run(_command, _args, options) {
        let pending = '';
        options.onSpawn?.({
          writeStdin: (data) => {
            pending += data;
          },
          endStdin: () => {
            const req = JSON.parse(pending) as { id: number };
            options.onStdoutLine?.(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }));
          },
          kill: () => {},
        });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const recorder = new RecordingCliRunner(eofProtocolRunner, recDir);
    await recorder.run('/usr/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      onSpawn: (controls) => {
        controls.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
        controls.endStdin();
      },
    });

    const [rec] = await readRecordings(recDir);
    expect(rec.events?.map((e) => e.direction)).toEqual(['stdin', 'stdin_end', 'stdout']);

    const entries = convertRecordingToReplayEntries(rec);
    expect(entries).toEqual([
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { ok: true } } },
      { type: 'exit', exitCode: 0 },
    ]);
  });
});

describe('recordings.mjs linear replay converter', () => {
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('converts recorded cross-direction events into linear expect_outbound, emit_inbound with optional afterMs, and exit', () => {
    const recording = {
      file: '01-codex-app-server.json',
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      match: { provider: 'codex', model: 'gpt-6.2-sol' },
      events: [
        { direction: 'stdin', atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' },
        { direction: 'stdout', atMs: 17, data: '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex"}}' },
        { direction: 'stdin', atMs: 17, data: '{"jsonrpc":"2.0","method":"initialized","params":{}}\n' },
        { direction: 'stdin', atMs: 17, data: '{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/repo"}}\n' },
        // Same millisecond as previous stdin write -> afterMs omitted (0ms delay), order preserved from events.
        { direction: 'stdout', atMs: 17, data: '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"t1"}}}' },
        { direction: 'stdout', atMs: 42, data: '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"t1"}}' },
      ],
      stdoutLines: [
        '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex"}}',
        '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"t1"}}}',
        '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"t1"}}',
      ],
      stdoutTimesMs: [17, 17, 42],
      stdinWrites: [
        { atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' },
        { atMs: 17, data: '{"jsonrpc":"2.0","method":"initialized","params":{}}\n' },
        { atMs: 17, data: '{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/repo"}}\n' },
      ],
      stderrLines: [],
      exitCode: 0,
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    };

    const turn = recordingToTranscriptTurn(recording);
    expect(turn.id).toBe('01-codex-app-server');
    expect(turn.match).toEqual({ provider: 'codex', model: 'gpt-6.2-sol' });
    expect(turn.stdoutLines).toHaveLength(3);
    expect(turn.exitCode).toBe(0);
    expect(turn.entries).toEqual([
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } }, afterMs: 12 },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', method: 'initialized', params: {} } },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: '/repo' } } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 2, result: { thread: { id: 't1' } } } },
      {
        type: 'emit_inbound',
        frame: { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't1' } },
        afterMs: 25,
      },
      { type: 'exit', exitCode: 0 },
    ]);
  });

  it('preserves non-zero exit code and termination flags on the exit entry', () => {
    const recording = {
      id: 'aborted-acp',
      provider: 'antigravity',
      args: ['acp'],
      events: [
        { direction: 'stdin', atMs: 2, data: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' },
        { direction: 'stdout', atMs: 10, data: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}' },
        { direction: 'stdin', atMs: 15, data: '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}\n' },
      ],
      stderrLines: ['cancelled'],
      exitCode: 130,
      aborted: true,
    };

    const entries = convertRecordingToReplayEntries(recording);
    expect(entries.at(-1)).toEqual({ type: 'exit', exitCode: 130, aborted: true });
  });

  it('omits afterMs when events lack timestamps and preserves raw non-JSON lines alongside JSON frames', () => {
    const entries = convertRecordingToReplayEntries({
      id: 'untimed-and-plain',
      provider: 'codex',
      events: [
        { direction: 'stdout', data: 'Starting app-server...' },
        { direction: 'stdin', data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' },
        { direction: 'stdout', data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' },
      ],
      exitCode: 0,
    });

    expect(entries).toEqual([
      { type: 'emit_inbound', frame: 'Starting app-server...' },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { ok: true } } },
      { type: 'exit', exitCode: 0 },
    ]);
  });

  it('converts a single-sided legacy interactive recording with stdinWrites and empty stdoutLines', () => {
    const entries = convertRecordingToReplayEntries({
      id: 'crashed-before-reply',
      provider: 'codex',
      stdinWrites: [{ atMs: 4, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' }],
      stdoutLines: [],
      stdoutTimesMs: [],
      stderrLines: ['sandbox error'],
      exitCode: 1,
      timedOut: true,
    });

    expect(entries).toEqual([
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { type: 'exit', exitCode: 1, timedOut: true },
    ]);
  });

  it('reassembles chunked stdin writes across calls, packed lines, CRLF splits, and interleaved stdout', () => {
    expect(
      reassembleStdinWrites([
        { atMs: 5, data: '{"id":1,' },
        { atMs: 8, data: '"method":"initialize"}\r' },
        { atMs: 9, data: '\n{"id":2,"method":"ping"}\n{"id":3,' },
        { atMs: 14, data: '"method":"done"}' },
      ]),
    ).toEqual([
      { atMs: 9, data: '{"id":1,"method":"initialize"}' },
      { atMs: 9, data: '{"id":2,"method":"ping"}' },
      { atMs: 14, data: '{"id":3,"method":"done"}' },
    ]);

    const recording = {
      id: 'interleaved-chunks',
      provider: 'claude-code',
      args: ['--input-format', 'stream-json', '--output-format', 'stream-json'],
      events: [
        // First half of stdin frame arrives at 5ms; stdout arrives at 10ms before stdin frame completes at 14ms.
        { direction: 'stdin', atMs: 5, data: '{"type":"user","message":' },
        { direction: 'stdout', atMs: 10, data: '{"type":"system","subtype":"init","session_id":"c1"}' },
        { direction: 'stdin', atMs: 14, data: '{"role":"user","content":"Hello"}}\r\n{"type":"control_request",' },
        { direction: 'stdin', atMs: 20, data: '"request_id":"req-1","request":{"subtype":"interrupt"}}\n' },
        { direction: 'stdout', atMs: 35, data: '{"type":"result","subtype":"error","is_error":true,"session_id":"c1"}' },
      ],
      exitCode: 0,
    };

    const entries = convertRecordingToReplayEntries(recording);
    expect(entries).toEqual([
      {
        type: 'emit_inbound',
        frame: { type: 'system', subtype: 'init', session_id: 'c1' },
        afterMs: 10,
      },
      {
        type: 'expect_outbound',
        frame: { type: 'user', message: { role: 'user', content: 'Hello' } },
      },
      {
        type: 'expect_outbound',
        frame: { type: 'control_request', request_id: 'req-1', request: { subtype: 'interrupt' } },
      },
      {
        type: 'emit_inbound',
        frame: { type: 'result', subtype: 'error', is_error: true, session_id: 'c1' },
        afterMs: 15,
      },
      { type: 'exit', exitCode: 0 },
    ]);
  });

  it('supports legacy recordings without events when timestamps are strictly unambiguous and preserves non-interactive replay', async () => {
    const dir = makeTempDir('dalang-rec-legacy-');
    const recDir = path.join(dir, 'rec');
    fs.mkdirSync(recDir, { recursive: true });

    // 1. Legacy non-interactive one-shot recording (no events, empty stdinWrites)
    const legacyNonInteractive = {
      recordedAt: '2026-11-25T10:00:00.000Z',
      provider: 'claude-code',
      command: 'claude',
      args: ['-p', 'Summarize README', '--model', 'opus'],
      cwd: '/repo',
      promptHead: 'Summarize README',
      durationMs: 120,
      firstStdoutMs: 40,
      match: { provider: 'claude-code', model: 'opus' },
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"legacy-s1"}',
        '{"type":"result","subtype":"success","session_id":"legacy-s1","result":"All good"}',
      ],
      stdoutTimesMs: [40, 115],
      stderrLines: [],
      stdinWrites: [],
      exitCode: 0,
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    };

    // 2. Legacy interactive recording (no events, chunked stdinWrites, unambiguous strictly separated timestamps)
    const legacyInteractive = {
      recordedAt: '2026-11-25T10:01:00.000Z',
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/repo',
      promptHead: 'app-server',
      durationMs: 60,
      firstStdoutMs: 15,
      match: { provider: 'codex' },
      stdinWrites: [
        { atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize",' },
        { atMs: 8, data: '"params":{"clientInfo":{"name":"dalang"}}}\n' },
        { atMs: 18, data: '{"jsonrpc":"2.0","method":"initialized","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"thread/start",' },
        { atMs: 20, data: '"params":{"cwd":"/repo"}}\n' },
      ],
      stdoutLines: [
        '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex"}}',
        '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"legacy-t1"}}}',
      ],
      stdoutTimesMs: [15, 28],
      stderrLines: [],
      exitCode: 0,
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    };

    // 3. Codex rate-limit health probe (must be filtered out by isTurnRecording)
    const codexRateLimitProbe = {
      recordedAt: '2026-11-25T09:59:00.000Z',
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      stdinWrites: [
        { atMs: 2, data: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' },
        { atMs: 6, data: '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}\n' },
      ],
      stdoutLines: [
        '{"jsonrpc":"2.0","id":1,"result":{}}',
        '{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{}}}',
      ],
      stdoutTimesMs: [4, 10],
      stderrLines: [],
      exitCode: 0,
    };

    expect(isTurnRecording(codexRateLimitProbe)).toBe(false);
    expect(isTurnRecording(legacyInteractive)).toBe(true);

    fs.writeFileSync(path.join(recDir, '00-probe.json'), JSON.stringify(codexRateLimitProbe));
    fs.writeFileSync(path.join(recDir, '01-oneshot.json'), JSON.stringify(legacyNonInteractive));
    fs.writeFileSync(path.join(recDir, '02-interactive.json'), JSON.stringify(legacyInteractive));

    const output = execFileSync(process.execPath, [RECORDINGS_SCRIPT, 'transcript', recDir, 'mixed-legacy'], {
      encoding: 'utf8',
    });
    const transcript = JSON.parse(output) as ReplayTranscript & {
      turns: Array<ReplayTranscript['turns'][number] & { entries?: unknown[] }>;
    };
    expect(transcript.name).toBe('mixed-legacy');
    expect(transcript.turns).toHaveLength(2);

    // Non-interactive turn keeps the existing format without `entries` and runs through ReplayCliRunner.
    const [oneshotTurn, interactiveTurn] = transcript.turns;
    expect(oneshotTurn.id).toBe('01-oneshot');
    expect(oneshotTurn.entries).toBeUndefined();
    expect(oneshotTurn.stdoutLines).toEqual(legacyNonInteractive.stdoutLines);

    const replayRunner = new ReplayCliRunner({ name: 'oneshot-only', turns: [oneshotTurn], binaries: ['claude'] });
    const replayRes = await replayRunner.run('/usr/local/bin/claude', ['-p', 'Summarize README', '--model', 'opus'], {
      cwd: dir,
    });
    expect(replayRes.exitCode).toBe(0);
    expect(replayRes.stdout).toContain('All good');

    // Legacy interactive turn is converted cleanly to linear entries.
    expect(interactiveTurn.id).toBe('02-interactive');
    expect(interactiveTurn.entries).toEqual([
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'dalang' } } } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } }, afterMs: 7 },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', method: 'initialized', params: {} } },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: '/repo' } } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 2, result: { thread: { id: 'legacy-t1' } } }, afterMs: 8 },
      { type: 'exit', exitCode: 0 },
    ]);

    // --provider filter works via CLI.
    const codexOnly = JSON.parse(
      execFileSync(process.execPath, [RECORDINGS_SCRIPT, 'transcript', recDir, 'codex-only', '--provider', 'codex'], {
        encoding: 'utf8',
      }),
    ) as ReplayTranscript;
    expect(codexOnly.turns.map((t) => t.id)).toEqual(['02-interactive']);

    // summary command still works and classifies codex rate-limit probe as health.
    const summaryOut = execFileSync(process.execPath, [RECORDINGS_SCRIPT, 'summary', recDir], {
      encoding: 'utf8',
    });
    expect(summaryOut).toContain('codex health');
    expect(summaryOut).toContain('codex codex app-server');
    expect(summaryOut).toContain('claude-code claude -p');
  });

  it('places an unterminated stdin frame at stdin_end before subsequent stdout and computes afterMs from stdin_end', () => {
    const entries = convertRecordingToReplayEntries({
      id: 'unterminated-with-stdin-end',
      provider: 'codex',
      events: [
        { direction: 'stdin', atMs: 5, data: '{"jsonrpc":"2.0","id":1,' },
        { direction: 'stdout', atMs: 9, data: '{"jsonrpc":"2.0","method":"server/ready"}' },
        { direction: 'stdin', atMs: 12, data: '"method":"initialize"}' },
        { direction: 'stdin_end', atMs: 15 },
        { direction: 'stdout', atMs: 27, data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' },
      ],
      exitCode: 0,
    });

    expect(entries).toEqual([
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', method: 'server/ready' }, afterMs: 9 },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { ok: true } }, afterMs: 12 },
      { type: 'exit', exitCode: 0 },
    ]);
  });

  it('fails clearly for interactive inputs that lack a trustworthy cross-direction ordering', () => {
    // 0a. Unterminated stdin frame followed by stdout without newline or stdin_end in `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'unterminated-before-stdout',
        provider: 'codex',
        events: [
          { direction: 'stdin', atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' },
          { direction: 'stdout', atMs: 12, data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' },
        ],
        exitCode: 0,
      }),
    ).toThrow(/unterminated stdin frame is followed by stdout/i);

    // 0b. Unterminated stdin frame followed by stdout in legacy recording without `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'legacy-unterminated-before-stdout',
        provider: 'codex',
        stdinWrites: [{ atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' }],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'],
        stdoutTimesMs: [12],
        exitCode: 0,
      }),
    ).toThrow(/unterminated stdin frame is followed by stdout/i);

    // 1. Cross-direction timestamp tie without `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'tied-timestamps',
        provider: 'codex',
        stdinWrites: [{ atMs: 10, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' }],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
        stdoutTimesMs: [10],
        exitCode: 0,
      }),
    ).toThrow(/ambiguous cross-direction ordering at 10ms/i);

    // 2. Missing stdoutTimesMs without `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'missing-stdout-times',
        provider: 'codex',
        stdinWrites: [{ atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' }],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
        exitCode: 0,
      }),
    ).toThrow(/missing or incomplete stdoutTimesMs/i);

    // 3. Missing stdin write timestamp on completing chunk without `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'missing-stdin-time',
        provider: 'codex',
        stdinWrites: [
          { atMs: 5, data: '{"jsonrpc":"2.0","id":1,' },
          { data: '"method":"initialize"}\n' },
        ],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
        stdoutTimesMs: [15],
        exitCode: 0,
      }),
    ).toThrow(/missing or invalid stdinWrites\[1\]\.atMs/i);

    // 4. Non-monotonic stdout timestamps without `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'non-monotonic-stdout',
        provider: 'codex',
        stdinWrites: [{ atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' }],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}', '{"jsonrpc":"2.0","method":"done"}'],
        stdoutTimesMs: [20, 12],
        exitCode: 0,
      }),
    ).toThrow(/non-monotonic stdoutTimesMs/i);

    // 5. Non-monotonic stdin timestamps without `events`
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'non-monotonic-stdin',
        provider: 'codex',
        stdinWrites: [
          { atMs: 25, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' },
          { atMs: 12, data: '{"jsonrpc":"2.0","id":2,"method":"thread/start"}\n' },
        ],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
        stdoutTimesMs: [30],
        exitCode: 0,
      }),
    ).toThrow(/non-monotonic stdinWrites/i);

    // 6. Contradictory/empty events array when stdinWrites has interactive frames
    expect(() =>
      buildTranscriptFromRecordings([
        {
          id: 'empty-events',
          provider: 'codex',
          args: ['app-server'],
          events: [],
          stdinWrites: [{ atMs: 5, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' }],
          stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
          stdoutTimesMs: [15],
          exitCode: 0,
        },
      ]),
    ).toThrow(/events stdin payload does not match stdinWrites/i);

    // 7. Malformed event direction
    expect(() =>
      convertRecordingToReplayEntries({
        id: 'bad-direction',
        provider: 'codex',
        events: [{ direction: 'stderr', atMs: 5, data: 'oops' }],
        exitCode: 0,
      }),
    ).toThrow(/invalid event direction at index 0/i);

    // 8. CLI exits non-zero with a clear diagnostic message on stderr for untrustworthy interactive input
    const dir = makeTempDir('dalang-rec-untrustworthy-');
    fs.writeFileSync(
      path.join(dir, '01-ambiguous.json'),
      JSON.stringify({
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        stdinWrites: [{ atMs: 10, data: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' }],
        stdoutLines: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
        stdoutTimesMs: [10],
        stderrLines: [],
        exitCode: 0,
      }),
    );

    const cliRes = spawnSync(process.execPath, [RECORDINGS_SCRIPT, 'transcript', dir, 'bad-case'], {
      encoding: 'utf8',
    });
    expect(cliRes.status).toBe(1);
    expect(cliRes.stdout).toBe('');
    expect(cliRes.stderr).toMatch(/01-ambiguous\.json.*ambiguous cross-direction ordering at 10ms/i);
  });
});
