import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DALANG_VERSION } from '@dalang/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityAdapter } from '../adapters/antigravity.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import type { ActiveTurnControls } from '../adapters/types.js';
import {
  ReplayCliRunner,
  type ReplayScriptEntry,
  type ReplayTranscript,
} from '../testing/replay-runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_SCRIPT = path.resolve(here, '../../scripts/recordings.mjs');

interface RecordingsModule {
  buildTranscriptFromRecordings: (
    recordings: Array<Record<string, unknown>>,
    options?: { name?: string; description?: string; provider?: string | null },
  ) => ReplayTranscript;
}

const { buildTranscriptFromRecordings } = (await import(
  pathToFileURL(RECORDINGS_SCRIPT).href
)) as RecordingsModule;

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('R1 interactive linear replay runner (B6 regression)', () => {
  it('B6 regression: enables interactive stdin for linear scripts and replays Codex app-server steer, interrupt, and resume with bounded ID normalization', async () => {
    const projectDir = makeTempDir('dalang-replay-codex-');
    const transcript: ReplayTranscript = {
      name: 'codex-interactive-session',
      binaries: ['codex'],
      turns: [
        {
          id: 'codex-steer-and-interrupt',
          match: { provider: 'codex' },
          entries: [
            // Recorded request IDs (10, 20, 30, 40, 50) differ from live sequential IDs (1..5).
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: { clientInfo: { name: 'dalang', version: DALANG_VERSION } },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 10, result: { userAgent: 'codex-replay' } },
            },
            {
              type: 'expect_outbound',
              frame: { jsonrpc: '2.0', method: 'initialized', params: {} },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 20,
                method: 'thread/start',
                params: {
                  cwd: projectDir,
                  model: null,
                  approvalPolicy: 'never',
                  sandbox: 'workspace-write',
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 20, result: { thread: { id: 'thread-rec-1' } } },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 30,
                method: 'turn/start',
                params: {
                  threadId: 'thread-rec-1',
                  input: [{ type: 'text', text: 'Start task', text_elements: [] }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 30, result: { turn: { id: 'turn-rec-1' } } },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 40,
                method: 'turn/steer',
                params: {
                  threadId: 'thread-rec-1',
                  expectedTurnId: 'turn-rec-1',
                  input: [{ type: 'text', text: 'Keep existing tests', text_elements: [] }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 40, result: {} },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 50,
                method: 'turn/interrupt',
                params: { threadId: 'thread-rec-1', turnId: 'turn-rec-1' },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 50, result: {} },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                method: 'turn/completed',
                params: { threadId: 'thread-rec-1', turn: { id: 'turn-rec-1', status: 'interrupted' } },
              },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
        {
          id: 'codex-resume',
          match: { provider: 'codex' },
          files: {
            'src/done.txt': 'resumed output\n',
          },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 100,
                method: 'initialize',
                params: { clientInfo: { name: 'dalang', version: DALANG_VERSION } },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 100, result: {} },
            },
            {
              type: 'expect_outbound',
              frame: { jsonrpc: '2.0', method: 'initialized', params: {} },
            },
            // Recorded threadId differs from the live resumed threadId (`thread-rec-1` vs `thread-recorded-old`).
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 200,
                method: 'thread/resume',
                params: {
                  threadId: 'thread-recorded-old',
                  excludeTurns: true,
                  cwd: projectDir,
                  model: null,
                  approvalPolicy: 'never',
                  sandbox: 'workspace-write',
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 200, result: { thread: { id: 'thread-recorded-old' } } },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 300,
                method: 'turn/start',
                params: {
                  threadId: 'thread-recorded-old',
                  input: [{ type: 'text', text: 'Continue task', text_elements: [] }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 300, result: { turn: { id: 'turn-rec-2' } } },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                method: 'item/completed',
                params: {
                  threadId: 'thread-recorded-old',
                  item: { type: 'agentMessage', text: 'All resumed cleanly' },
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                method: 'turn/completed',
                params: { threadId: 'thread-recorded-old', turn: { id: 'turn-rec-2', status: 'completed' } },
              },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    };

    const runner = new ReplayCliRunner(transcript);
    expect(runner.supportsInteractiveStdin).toBe(true);

    const adapter = new CodexAdapter(runner);
    // Health usage probe must still work without consuming the interactive session turns.
    const usage = await adapter.getUsage();
    expect(usage.available).toBe(true);

    let ready!: (controls: ActiveTurnControls) => void;
    const controlsPromise = new Promise<ActiveTurnControls>((resolve) => {
      ready = resolve;
    });
    const firstTurn = adapter.runTurn({
      projectPath: projectDir,
      prompt: 'Start task',
      onControls: (controls) => {
        if (controls) ready(controls);
      },
    });
    const controls = await controlsPromise;
    await controls.steer?.('Keep existing tests');
    await controls.interrupt();

    const interrupted = await firstTurn;
    expect(interrupted).toMatchObject({
      sessionId: 'thread-rec-1',
      aborted: true,
      exitCode: 0,
    });
    expect(runner.invocations.find((i) => i.matchedTurnId === 'codex-steer-and-interrupt')?.innerArgs).toEqual([
      'app-server',
    ]);

    const resumed = await adapter.runTurn({
      projectPath: projectDir,
      sessionId: interrupted.sessionId,
      prompt: 'Continue task',
    });
    expect(resumed).toMatchObject({
      sessionId: 'thread-rec-1',
      aborted: false,
      exitCode: 0,
      text: 'All resumed cleanly',
    });
    expect(fs.readFileSync(path.join(projectDir, 'src/done.txt'), 'utf8')).toBe('resumed output\n');
  });

  it('B6 regression: replays Claude stream-json interactive session (prompt, steer with random uuid, interrupt with random request_id)', async () => {
    const projectDir = makeTempDir('dalang-replay-claude-');
    const transcript: ReplayTranscript = {
      name: 'claude-interactive-session',
      binaries: ['claude'],
      turns: [
        {
          id: 'claude-steer-and-complete',
          match: { provider: 'claude-code' },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                type: 'user',
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: 'Analyze module' }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { type: 'system', subtype: 'init', session_id: 'claude-sess-1', model: 'claude-sonnet-5-5' },
            },
            {
              type: 'expect_outbound',
              frame: {
                type: 'user',
                message: { role: 'user', content: 'Focus on edge cases' },
                parent_tool_use_id: null,
                uuid: 'recorded-steer-uuid',
                priority: 'now',
              },
            },
            // Rewriting maps `recorded-steer-uuid` to the live random UUID so ClaudeCodeAdapter clears pendingSteering and closes stdin.
            {
              type: 'emit_inbound',
              frame: {
                type: 'result',
                subtype: 'success',
                session_id: 'claude-sess-1',
                user_message_uuid: 'recorded-steer-uuid',
                result: 'Edge cases checked',
              },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
        {
          id: 'claude-interrupt',
          match: { provider: 'claude-code' },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                type: 'user',
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: 'Long task' }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { type: 'system', subtype: 'init', session_id: 'claude-sess-2' },
            },
            {
              type: 'expect_outbound',
              frame: {
                type: 'control_request',
                request_id: 'recorded-interrupt-req-id',
                request: { subtype: 'interrupt' },
              },
            },
            {
              type: 'emit_inbound',
              frame: {
                type: 'control_response',
                response: { subtype: 'success', request_id: 'recorded-interrupt-req-id', response: {} },
              },
            },
            {
              type: 'emit_inbound',
              frame: { type: 'result', is_error: true, result: 'interrupted', session_id: 'claude-sess-2' },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    };

    const runner = new ReplayCliRunner(transcript);
    expect(runner.supportsInteractiveStdin).toBe(true);
    const adapter = new ClaudeCodeAdapter(runner);

    // Turn 1: prompt + steer -> normal completion
    let ready1!: (controls: ActiveTurnControls) => void;
    const active1 = new Promise<ActiveTurnControls>((resolve) => {
      ready1 = resolve;
    });
    const turn1Promise = adapter.runTurn({
      projectPath: projectDir,
      prompt: 'Analyze module',
      onControls: (c) => {
        if (c) ready1(c);
      },
    });
    const controls1 = await active1;
    await controls1.steer?.('Focus on edge cases');
    const turn1 = await turn1Promise;
    expect(turn1).toMatchObject({
      sessionId: 'claude-sess-1',
      text: 'Edge cases checked',
      aborted: false,
      exitCode: 0,
    });
    const inv1 = runner.invocations.find((i) => i.matchedTurnId === 'claude-steer-and-complete')!;
    expect(inv1.innerArgs).toContain('--input-format');
    expect(inv1.innerArgs).not.toContain('Analyze module');

    // Turn 2: prompt + interrupt -> aborted cleanly
    let ready2!: (controls: ActiveTurnControls) => void;
    const active2 = new Promise<ActiveTurnControls>((resolve) => {
      ready2 = resolve;
    });
    const turn2Promise = adapter.runTurn({
      projectPath: projectDir,
      prompt: 'Long task',
      onControls: (c) => {
        if (c) ready2(c);
      },
    });
    const controls2 = await active2;
    await controls2.interrupt();
    const turn2 = await turn2Promise;
    expect(turn2).toMatchObject({
      sessionId: 'claude-sess-2',
      aborted: true,
      exitCode: 0,
    });
  });

  it('B6 regression: replays Antigravity ACP interactive session including server-to-client permission request and cancel', async () => {
    const projectDir = makeTempDir('dalang-replay-agy-');
    const transcript: ReplayTranscript = {
      name: 'agy-acp-session',
      binaries: ['agy'],
      turns: [
        {
          id: 'agy-acp-turn',
          match: { provider: 'antigravity' },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 50,
                method: 'initialize',
                params: {
                  protocolVersion: 1,
                  clientCapabilities: {},
                  clientInfo: { name: 'dalang', version: DALANG_VERSION },
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 50, result: { protocolVersion: 1 } },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 51,
                method: 'session/new',
                params: { cwd: projectDir, mcpServers: [] },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 51, result: { sessionId: 'agy-sess-1', modes: {} } },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 52,
                method: 'session/set_mode',
                params: { sessionId: 'agy-sess-1', modeId: 'accept-edits' },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 52, result: {} },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 53,
                method: 'session/prompt',
                params: {
                  sessionId: 'agy-sess-1',
                  prompt: [{ type: 'text', text: 'Inspect files' }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                id: 901,
                method: 'session/request_permission',
                params: { sessionId: 'agy-sess-1', toolCall: { toolCallId: 'tc-1', title: 'Write file' } },
              },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 901,
                result: { outcome: { outcome: 'cancelled' } },
              },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'agy-sess-1',
                  update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ACP reply' } },
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 53, result: { stopReason: 'end_turn' } },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    };

    const runner = new ReplayCliRunner(transcript);
    expect(runner.supportsInteractiveStdin).toBe(true);
    const adapter = new AntigravityAdapter(runner, { antigravityKeyringAccess: () => false });
    const result = await adapter.runTurn({
      projectPath: projectDir,
      prompt: 'Inspect files',
    });

    expect(result).toMatchObject({
      sessionId: 'agy-sess-1',
      text: 'ACP reply',
      aborted: false,
      exitCode: 0,
    });
    expect(runner.invocations[0].innerArgs).toEqual(['acp', '--stdio']);
  });

  it('replays a transcript directly produced by recordings.mjs through CodexAdapter', async () => {
    const projectDir = makeTempDir('dalang-replay-from-rec-');
    const recording = {
      file: '01-codex-app-server.json',
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      match: { provider: 'codex' },
      events: [
        {
          direction: 'stdin',
          atMs: 2,
          data: `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { clientInfo: { name: 'dalang', version: DALANG_VERSION } } })}\n`,
        },
        { direction: 'stdout', atMs: 5, data: JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} }) },
        {
          direction: 'stdin',
          atMs: 6,
          data: `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`,
        },
        {
          direction: 'stdin',
          atMs: 7,
          data: `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'thread/start', params: { cwd: projectDir, model: null, approvalPolicy: 'never', sandbox: 'read-only' } })}\n`,
        },
        {
          direction: 'stdout',
          atMs: 10,
          data: JSON.stringify({ jsonrpc: '2.0', id: 8, result: { thread: { id: 'thr-from-rec' } } }),
        },
        {
          direction: 'stdin',
          atMs: 11,
          data: `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'turn/start', params: { threadId: 'thr-from-rec', input: [{ type: 'text', text: 'Ping', text_elements: [] }] } })}\n`,
        },
        {
          direction: 'stdout',
          atMs: 12,
          data: JSON.stringify({ jsonrpc: '2.0', id: 9, result: { turn: { id: 'trn-from-rec' } } }),
        },
        {
          direction: 'stdout',
          atMs: 15,
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: { threadId: 'thr-from-rec', item: { type: 'agentMessage', text: 'Pong' } },
          }),
        },
        {
          direction: 'stdout',
          atMs: 16,
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: 'thr-from-rec', turn: { id: 'trn-from-rec', status: 'completed' } },
          }),
        },
      ],
      stdoutLines: [
        JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 8, result: { thread: { id: 'thr-from-rec' } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 9, result: { turn: { id: 'trn-from-rec' } } }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { threadId: 'thr-from-rec', item: { type: 'agentMessage', text: 'Pong' } },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 'thr-from-rec', turn: { id: 'trn-from-rec', status: 'completed' } },
        }),
      ],
      stderrLines: [],
      exitCode: 0,
    };

    const transcript = buildTranscriptFromRecordings([recording], { name: 'from-recordings' });
    transcript.binaries = ['codex'];
    const runner = new ReplayCliRunner(transcript);
    const result = await new CodexAdapter(runner).runTurn({
      projectPath: projectDir,
      prompt: 'Ping',
      permissionMode: 'read-only',
    });

    expect(result).toMatchObject({
      sessionId: 'thr-from-rec',
      text: 'Pong',
      exitCode: 0,
      aborted: false,
    });
  });

  it('follows strict linear order, handles chunked stdin writes, and respects emit_inbound afterMs delays with clean timer teardown', async () => {
    vi.useFakeTimers();

    const entries: ReplayScriptEntry[] = [
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { ok: true } }, afterMs: 25 },
      { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 2, method: 'ping', params: {} } },
      { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 2, result: { pong: true } }, afterMs: 40 },
      { type: 'exit', exitCode: 0 },
    ];

    const runner = new ReplayCliRunner({
      name: 'ordered-delayed',
      binaries: ['codex'],
      turns: [{ match: { provider: 'codex' }, entries }],
    });

    const received: string[] = [];
    let controls!: { writeStdin: (data: string) => void; endStdin: () => void; kill: () => void };

    const runPromise = runner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      idleTimeoutMs: 2000,
      onSpawn: (c) => {
        controls = c;
      },
      onStdoutLine: (line) => received.push(line),
    });

    // Send first frame in two chunks across CRLF.
    controls.writeStdin('{"jsonrpc":"2.0","id":99,');
    controls.writeStdin('"method":"initialize","params":{}}\r\n');

    await vi.advanceTimersByTimeAsync(24);
    expect(received).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([JSON.stringify({ jsonrpc: '2.0', id: 99, result: { ok: true } })]);

    // Send second frame without trailing newline, closed by endStdin().
    controls.writeStdin('{"jsonrpc":"2.0","id":100,"method":"ping","params":{}}');
    controls.endStdin();

    await vi.advanceTimersByTimeAsync(39);
    expect(received).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const res = await runPromise;
    expect(res.exitCode).toBe(0);
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[1])).toEqual({ jsonrpc: '2.0', id: 100, result: { pong: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails immediately on wrong, out-of-order, invalid-JSON, missing, or unexpected extra outbound frames without leaking secrets or timers', async () => {
    vi.useFakeTimers();

    // 1. Out-of-order / wrong outbound frame (never reorders; redacts raw secret values).
    const wrongRunner = new ReplayCliRunner({
      name: 'wrong-frame',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 1,
                method: 'turn/start',
                params: { input: [{ type: 'text', text: 'EXPECTED_SECRET_PROMPT' }] },
              },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const wrongStderr: string[] = [];
    const wrongRes = await wrongRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      idleTimeoutMs: 2000,
      onStderrLine: (line) => wrongStderr.push(line),
      onSpawn: (c) => {
        c.writeStdin(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'turn/start',
            params: { input: [{ type: 'text', text: 'ACTUAL_SECRET_PROMPT' }] },
          })}\n`,
        );
      },
    });
    expect(wrongRes.exitCode).toBe(1);
    expect(wrongRes.timedOut).toBe(false);
    expect(wrongStderr.join('\n')).toContain('outbound frame mismatch at entry 0');
    expect(wrongStderr.join('\n')).toContain('params.input[0].text');
    expect(wrongRes.stderr).not.toContain('EXPECTED_SECRET_PROMPT');
    expect(wrongRes.stderr).not.toContain('ACTUAL_SECRET_PROMPT');
    expect(vi.getTimerCount()).toBe(0);

    // 2. Invalid JSON sent on stdin.
    const invalidJsonRunner = new ReplayCliRunner({
      name: 'invalid-json',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const invalidRes = await invalidJsonRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      onSpawn: (c) => {
        c.writeStdin('{"broken":"TOP_SECRET_LINE"\n');
      },
    });
    expect(invalidRes.exitCode).toBe(1);
    expect(invalidRes.stderr).toContain('invalid_json');
    expect(invalidRes.stderr).not.toContain('TOP_SECRET_LINE');
    expect(vi.getTimerCount()).toBe(0);

    // 3. Missing outbound frame (stdin closed early).
    const missingRunner = new ReplayCliRunner({
      name: 'missing-frame',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: {} } },
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 2, method: 'thread/start' } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const missingRes = await missingRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      idleTimeoutMs: 2000,
      onSpawn: (c) => {
        c.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
        c.endStdin();
      },
    });
    expect(missingRes.exitCode).toBe(1);
    expect(missingRes.stderr).toContain('missing expected outbound frame at entry 2');
    expect(vi.getTimerCount()).toBe(0);

    // 4. Unexpected extra outbound frame after script completed.
    const extraRunner = new ReplayCliRunner({
      name: 'extra-frame',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: {} } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const extraRes = await extraRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      onSpawn: (c) => {
        c.writeStdin(
          '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"unexpected"}\n',
        );
      },
    });
    expect(extraRes.exitCode).toBe(1);
    expect(extraRes.stderr).toContain('unexpected outbound frame');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects outbound frames before a delayed inbound and scripts without a final exit', async () => {
    vi.useFakeTimers();
    const run = (entries: ReplayScriptEntry[], onSpawn: NonNullable<Parameters<ReplayCliRunner['run']>[2]['onSpawn']>) =>
      new ReplayCliRunner({ name: 'invalid-order', turns: [{ match: { provider: 'codex' }, entries }] })
        .run('codex', ['app-server'], { cwd: '/repo', interactiveStdin: true, onSpawn });

    const early = await run([
      { type: 'expect_outbound', frame: { method: 'first' } },
      { type: 'emit_inbound', frame: { method: 'ready' }, afterMs: 50 },
      { type: 'expect_outbound', frame: { method: 'second' } },
      { type: 'exit', exitCode: 0 },
    ], (controls) => {
      controls.writeStdin('{"method":"first"}\n');
      controls.writeStdin('{"method":"second"}\n');
    });
    expect(early.stderr).toContain('unexpected outbound frame before emit_inbound');
    expect(early.exitCode).toBe(1);
    expect(early.stdout).toBe('');

    const trailing = run([
      { type: 'emit_inbound', frame: { method: 'ready' }, afterMs: 50 },
      { type: 'exit', exitCode: 0 },
    ], (controls) => {
      controls.writeStdin('{"method":"early"}');
      controls.endStdin();
    });
    await vi.advanceTimersByTimeAsync(50);
    expect((await trailing).stderr).toContain('unexpected outbound frame before emit_inbound');

    for (const entries of [[], [{ type: 'exit', exitCode: 0 }, { type: 'exit', exitCode: 0 }]] as ReplayScriptEntry[][]) {
      const result = await run(entries, () => {});
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/without exit|entries remain after exit/);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces total timeout, idle timeout with onKeepAlive reset, and expectOutboundTimeoutMs with complete timer cleanup', async () => {
    vi.useFakeTimers();

    const makeWaitingTranscript = (): ReplayTranscript => ({
      name: 'waiting-for-outbound',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });

    // 1. Total timeoutMs fires while waiting for expect_outbound.
    const totalRunner = new ReplayCliRunner(makeWaitingTranscript());
    const totalPromise = totalRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 100,
      idleTimeoutMs: 500,
      onSpawn: () => {},
    });
    await vi.advanceTimersByTimeAsync(100);
    const totalRes = await totalPromise;
    expect(totalRes).toMatchObject({
      exitCode: null,
      timedOut: true,
      idleTimedOut: false,
      aborted: false,
    });
    expect(totalRes.stderr).toContain('timed out after 100ms while waiting for expect_outbound at entry 0');
    expect(vi.getTimerCount()).toBe(0);

    // 2. Idle timeoutMs resets on onKeepAlive and fires after inactivity.
    const idleRunner = new ReplayCliRunner(makeWaitingTranscript());
    let keepAlive!: () => void;
    const idlePromise = idleRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 1000,
      idleTimeoutMs: 100,
      onKeepAlive: (reset) => {
        keepAlive = reset;
      },
      onSpawn: () => {},
    });
    await vi.advanceTimersByTimeAsync(80);
    keepAlive();
    await vi.advanceTimersByTimeAsync(80);
    // Still alive because keepAlive reset the 100ms idle timer at t=80ms.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(20);
    const idleRes = await idlePromise;
    expect(idleRes).toMatchObject({
      exitCode: null,
      timedOut: false,
      idleTimedOut: true,
      aborted: false,
    });
    expect(idleRes.stderr).toContain('idle timed out after 100ms');
    expect(vi.getTimerCount()).toBe(0);

    // Calling keepAlive after settlement must not schedule stray timers.
    keepAlive();
    expect(vi.getTimerCount()).toBe(0);

    // 3. Runner-level expectOutboundTimeoutMs fires when waiting for an expected outbound frame.
    const stepTimeoutRunner = new ReplayCliRunner(makeWaitingTranscript(), {
      expectOutboundTimeoutMs: 75,
    });
    const stepPromise = stepTimeoutRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      idleTimeoutMs: 5000,
      onSpawn: () => {},
    });
    await vi.advanceTimersByTimeAsync(75);
    const stepRes = await stepPromise;
    expect(stepRes).toMatchObject({
      exitCode: null,
      timedOut: true,
      idleTimedOut: false,
      aborted: false,
    });
    expect(stepRes.stderr).toContain('timed out waiting for expect_outbound at entry 0 after 75ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles AbortSignal cancellation, kill(), and script exit flags while clearing all pending timers', async () => {
    vi.useFakeTimers();

    // 1. Pre-aborted signal returns immediately without spawning or scheduling timers.
    const preAbortController = new AbortController();
    preAbortController.abort();
    const preAbortRunner = new ReplayCliRunner({
      name: 'pre-abort',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'emit_inbound', frame: { ok: true }, afterMs: 500 },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const onSpawnPreAbort = vi.fn();
    const preAbortRes = await preAbortRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      signal: preAbortController.signal,
      onSpawn: onSpawnPreAbort,
    });
    expect(preAbortRes).toMatchObject({ exitCode: null, aborted: true, timedOut: false, idleTimedOut: false });
    expect(onSpawnPreAbort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // 2. Abort mid-script while a delayed emit_inbound timer is pending.
    const abortController = new AbortController();
    const abortRunner = new ReplayCliRunner({
      name: 'mid-abort',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: { late: true } }, afterMs: 200 },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const abortStdout: string[] = [];
    const abortPromise = abortRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      idleTimeoutMs: 5000,
      signal: abortController.signal,
      onStdoutLine: (line) => abortStdout.push(line),
      onSpawn: (c) => {
        c.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    abortController.abort();
    const abortRes = await abortPromise;
    expect(abortRes).toMatchObject({ exitCode: null, aborted: true, timedOut: false, idleTimedOut: false });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(abortStdout).toEqual([]);

    // 3. controls.kill() mid-script cancels delayed emit_inbound and all timers.
    const killRunner = new ReplayCliRunner({
      name: 'mid-kill',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: {} }, afterMs: 300 },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const killStdout: string[] = [];
    let killControls!: { writeStdin: (d: string) => void; kill: () => void };
    const killPromise = killRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      timeoutMs: 5000,
      idleTimeoutMs: 5000,
      onStdoutLine: (line) => killStdout.push(line),
      onSpawn: (c) => {
        killControls = c;
        c.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    killControls.kill();
    const killRes = await killPromise;
    expect(killRes).toMatchObject({ exitCode: null, aborted: false, timedOut: false, idleTimedOut: false });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(killStdout).toEqual([]);

    // 4. Script exit entry propagates non-zero exitCode, flags, and stderrLines.
    const exitRunner = new ReplayCliRunner({
      name: 'script-exit-error',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          stderrLines: ['Codex Linux sandbox failed to create user namespace'],
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
            { type: 'exit', exitCode: 1 },
          ],
        },
      ],
    });
    const stderrSeen: string[] = [];
    const exitPromise = exitRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      onStderrLine: (line) => stderrSeen.push(line),
      onSpawn: (c) => {
        c.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const exitRes = await exitPromise;
    expect(exitRes).toMatchObject({ exitCode: 1, timedOut: false, idleTimedOut: false, aborted: false });
    expect(stderrSeen).toEqual(['Codex Linux sandbox failed to create user namespace']);
    expect(exitRes.stderr).toContain('Codex Linux sandbox failed to create user namespace');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves legacy non-interactive replay behavior and abort-safe delayMs cleanup', async () => {
    vi.useFakeTimers();

    const projectDir = makeTempDir('dalang-replay-legacy-');
    const legacyTranscript: ReplayTranscript = {
      name: 'legacy-oneshot',
      binaries: ['claude', 'codex'],
      turns: [
        {
          id: 'legacy-claude-turn',
          match: { provider: 'claude-code', promptContains: 'Summarize' },
          files: { 'notes.txt': 'legacy file\n' },
          stdoutLines: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'legacy-c1', model: 'claude-sonnet-5-5' }),
            JSON.stringify({ type: 'result', subtype: 'success', session_id: 'legacy-c1', result: 'Summary ok' }),
          ],
          stderrLines: ['legacy stderr note'],
          exitCode: 0,
        },
        {
          id: 'legacy-delayed-codex',
          match: { provider: 'codex', promptContains: 'Slow legacy' },
          delayMs: 250,
          stdoutLines: [
            JSON.stringify({ type: 'thread.started', thread_id: 'legacy-x1' }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }),
          ],
          exitCode: 0,
        },
      ],
    };

    const runner = new ReplayCliRunner(legacyTranscript);
    expect(runner.supportsInteractiveStdin).toBe(false);

    const claudeResult = await new ClaudeCodeAdapter(runner).runTurn({
      projectPath: projectDir,
      prompt: 'Summarize README',
    });
    expect(claudeResult).toMatchObject({
      sessionId: 'legacy-c1',
      text: 'Summary ok',
      exitCode: 0,
      aborted: false,
    });
    expect(fs.readFileSync(path.join(projectDir, 'notes.txt'), 'utf8')).toBe('legacy file\n');

    // Aborting a legacy delayed turn cleans up its delay timer immediately.
    const abortController = new AbortController();
    const codexPromise = new CodexAdapter(runner).runTurn({
      projectPath: projectDir,
      prompt: 'Slow legacy turn',
      signal: abortController.signal,
    });
    await vi.advanceTimersByTimeAsync(50);
    abortController.abort();
    const codexResult = await codexPromise;
    expect(codexResult).toMatchObject({ aborted: true, exitCode: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves legacy turn selection across Claude, Codex, and Antigravity in mixed interactive+legacy transcripts', async () => {
    const projectDir = makeTempDir('dalang-replay-mixed-');
    const mixedTranscript: ReplayTranscript = {
      name: 'mixed-interactive-and-legacy',
      binaries: ['claude', 'codex', 'agy'],
      turns: [
        {
          id: 'interactive-codex',
          match: { provider: 'codex' },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: { clientInfo: { name: 'dalang', version: DALANG_VERSION } },
              },
            },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 10, result: {} } },
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', method: 'initialized', params: {} } },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 20,
                method: 'thread/start',
                params: {
                  cwd: projectDir,
                  model: null,
                  approvalPolicy: 'never',
                  sandbox: 'workspace-write',
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 20, result: { thread: { id: 'mixed-codex-thr' } } },
            },
            {
              type: 'expect_outbound',
              frame: {
                jsonrpc: '2.0',
                id: 30,
                method: 'turn/start',
                params: {
                  threadId: 'mixed-codex-thr',
                  input: [{ type: 'text', text: 'Interactive codex work', text_elements: [] }],
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: { jsonrpc: '2.0', id: 30, result: { turn: { id: 'mixed-codex-trn' } } },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                method: 'item/completed',
                params: {
                  threadId: 'mixed-codex-thr',
                  item: { type: 'agentMessage', text: 'Codex interactive done' },
                },
              },
            },
            {
              type: 'emit_inbound',
              frame: {
                jsonrpc: '2.0',
                method: 'turn/completed',
                params: {
                  threadId: 'mixed-codex-thr',
                  turn: { id: 'mixed-codex-trn', status: 'completed' },
                },
              },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
        {
          id: 'legacy-claude-review',
          match: { provider: 'claude-code', promptContains: 'code review round 1' },
          files: {
            '.dalang/review-note.txt': 'reviewed\n',
          },
          stdoutLines: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'mixed-claude-legacy', model: 'claude-sonnet-5-5' }),
            JSON.stringify({ type: 'result', subtype: 'success', session_id: 'mixed-claude-legacy', result: 'Legacy Claude review ok' }),
          ],
          exitCode: 0,
        },
        {
          id: 'interactive-claude-steer',
          match: { provider: 'claude-code' },
          entries: [
            {
              type: 'expect_outbound',
              frame: {
                type: 'user',
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: 'Interactive Claude task' }],
                },
              },
            },
            { type: 'emit_inbound', frame: { type: 'system', subtype: 'init', session_id: 'mixed-claude-int' } },
            {
              type: 'expect_outbound',
              frame: {
                type: 'user',
                message: { role: 'user', content: 'Steer via proxy' },
                parent_tool_use_id: null,
                uuid: 'rec-mixed-steer',
                priority: 'now',
              },
            },
            {
              type: 'emit_inbound',
              frame: {
                type: 'result',
                subtype: 'success',
                session_id: 'mixed-claude-int',
                user_message_uuid: 'rec-mixed-steer',
                result: 'Interactive Claude steered ok',
              },
            },
            { type: 'exit', exitCode: 0 },
          ],
        },
        {
          id: 'legacy-codex-exec',
          match: { provider: 'codex', promptContains: 'Fallback legacy codex' },
          stdoutLines: [
            JSON.stringify({ type: 'thread.started', thread_id: 'mixed-codex-legacy' }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Legacy Codex exec ok' } }),
          ],
          exitCode: 0,
        },
        {
          id: 'legacy-agy-oneshot',
          match: { provider: 'antigravity', promptContains: 'Fallback legacy agy' },
          stdoutLines: [
            JSON.stringify({ conversation_id: 'mixed-agy-legacy', response: 'Legacy Agy ok' }),
          ],
          exitCode: 0,
        },
      ],
    };

    const runner = new ReplayCliRunner(mixedTranscript);
    expect(runner.supportsInteractiveStdin).toBe(true);

    // 1. Interactive Codex turn runs over app-server.
    const codexAdapter = new CodexAdapter(runner);
    const codexInt = await codexAdapter.runTurn({
      projectPath: projectDir,
      prompt: 'Interactive codex work',
    });
    expect(codexInt).toMatchObject({
      sessionId: 'mixed-codex-thr',
      text: 'Codex interactive done',
      exitCode: 0,
    });

    // 2. Interactive Claude turn runs even while an unconsumed legacy Claude turn precedes it (promptContains does not match).
    const claudeAdapter = new ClaudeCodeAdapter(runner);
    let claudeReady!: (controls: ActiveTurnControls) => void;
    const claudeControlsPromise = new Promise<ActiveTurnControls>((resolve) => {
      claudeReady = resolve;
    });
    const claudeIntPromise = claudeAdapter.runTurn({
      projectPath: projectDir,
      prompt: 'Interactive Claude task',
      onControls: (c) => {
        if (c) claudeReady(c);
      },
    });
    const claudeControls = await claudeControlsPromise;
    await claudeControls.steer?.('Steer via proxy');
    const claudeInt = await claudeIntPromise;
    expect(claudeInt).toMatchObject({
      sessionId: 'mixed-claude-int',
      text: 'Interactive Claude steered ok',
      exitCode: 0,
    });

    // 3. Legacy Claude turn replays through ClaudeCodeAdapter's interactive session path with promptContains + session file mapping.
    const claudeLegacy = await claudeAdapter.runTurn({
      projectPath: projectDir,
      prompt: 'Run code review round 1 for .dalang/sessions/sess-99/task',
    });
    expect(claudeLegacy).toMatchObject({
      sessionId: 'mixed-claude-legacy',
      text: 'Legacy Claude review ok',
      exitCode: 0,
    });
    expect(
      fs.readFileSync(path.join(projectDir, '.dalang/sessions/sess-99/review-note.txt'), 'utf8'),
    ).toBe('reviewed\n');

    // 4. Legacy Codex turn replays via CodexAdapter fallback from app-server to codex exec.
    const codexLegacy = await codexAdapter.runTurn({
      projectPath: projectDir,
      prompt: 'Fallback legacy codex task',
    });
    expect(codexLegacy).toMatchObject({
      sessionId: 'mixed-codex-legacy',
      text: 'Legacy Codex exec ok',
      exitCode: 0,
    });

    // 5. Legacy Antigravity turn replays via AntigravityAdapter fallback from acp to one-shot.
    const agyAdapter = new AntigravityAdapter(runner, { antigravityKeyringAccess: () => false });
    const agyLegacy = await agyAdapter.runTurn({
      projectPath: projectDir,
      prompt: 'Fallback legacy agy task',
    });
    expect(agyLegacy).toMatchObject({
      sessionId: 'mixed-agy-legacy',
      text: 'Legacy Agy ok',
      exitCode: 0,
    });
  });

  it('feeds options.stdinData through interactive replay controls and closes stdin like NodeCliRunner', async () => {
    vi.useFakeTimers();

    // 1. Caller sends expected frame purely via options.stdinData (without trailing newline) and without onSpawn.
    const singleFrameRunner = new ReplayCliRunner({
      name: 'stdin-data-single',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} } },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 5, result: { ready: true } } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const stdoutSingle: string[] = [];
    const singleRes = await singleFrameRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      stdinData: '{"jsonrpc":"2.0","id":42,"method":"initialize","params":{}}',
      timeoutMs: 5000,
      idleTimeoutMs: 2000,
      onStdoutLine: (line) => stdoutSingle.push(line),
    });
    expect(singleRes).toMatchObject({ exitCode: 0, timedOut: false, idleTimedOut: false, aborted: false });
    expect(stdoutSingle).toEqual([JSON.stringify({ jsonrpc: '2.0', id: 42, result: { ready: true } })]);
    expect(vi.getTimerCount()).toBe(0);

    // 2. Caller writes frame 1 in onSpawn and frame 2 in options.stdinData (matching NodeCliRunner order).
    const combinedRunner = new ReplayCliRunner({
      name: 'stdin-data-after-onspawn',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
            { type: 'emit_inbound', frame: { jsonrpc: '2.0', id: 1, result: {} } },
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', method: 'initialized', params: {} } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const combinedRes = await combinedRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      stdinData: '{"jsonrpc":"2.0","method":"initialized","params":{}}\n',
      timeoutMs: 5000,
      onSpawn: (c) => {
        c.writeStdin('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
      },
    });
    expect(combinedRes).toMatchObject({ exitCode: 0, timedOut: false, idleTimedOut: false, aborted: false });
    expect(vi.getTimerCount()).toBe(0);

    // 3. Because options.stdinData closes stdin after writing, a missing subsequent frame fails immediately rather than timing out.
    const missingAfterStdinDataRunner = new ReplayCliRunner({
      name: 'stdin-data-missing-second',
      binaries: ['codex'],
      turns: [
        {
          match: { provider: 'codex' },
          entries: [
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
            { type: 'expect_outbound', frame: { jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} } },
            { type: 'exit', exitCode: 0 },
          ],
        },
      ],
    });
    const missingRes = await missingAfterStdinDataRunner.run('/usr/local/bin/codex', ['app-server'], {
      cwd: '/repo',
      interactiveStdin: true,
      stdinData: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      timeoutMs: 5000,
      idleTimeoutMs: 2000,
    });
    expect(missingRes).toMatchObject({ exitCode: 1, timedOut: false, idleTimedOut: false, aborted: false });
    expect(missingRes.stderr).toContain('missing expected outbound frame at entry 1');
    expect(vi.getTimerCount()).toBe(0);
  });
});
