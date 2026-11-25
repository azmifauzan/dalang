import { expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import { AntigravityAdapter } from '../adapters/antigravity.js';
import type { ActiveTurnControls, CliRunner, RunCommandResult } from '../adapters/types.js';

type Request = { id?: number; method: string; params: Record<string, unknown> };

function protocolRunner(
  binary: string,
  expectedCommand: string,
  handle: (request: Request, emit: (message: unknown) => void) => void,
): CliRunner {
  return {
    supportsInteractiveStdin: true,
    async which(name) { return name === binary ? binary : null; },
    async run(_command, args, options) {
      expect(args[0]).toBe(expectedCommand);
      return new Promise<RunCommandResult>((resolve) => {
        const close = () => resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false });
        options.onSpawn?.({
          writeStdin: (data) => handle(JSON.parse(data) as Request,
            (message) => options.onStdoutLine?.(JSON.stringify(message))),
          endStdin: close,
          kill: close,
        });
      });
    },
  };
}

it('steers and interrupts a Codex turn, then resumes the returned thread ID', async () => {
  const seen: Request[] = [];
  const runner = protocolRunner('codex', 'app-server', (request, emit) => {
    seen.push(request);
    const { id, method } = request;
    if (id === undefined) return;
    if (method === 'thread/start' || method === 'thread/resume') {
      emit({ id, result: { thread: { id: 'thread-1' } } });
    } else if (method === 'turn/start') {
      emit({ id, result: { turn: { id: 'turn-1' } } });
      if (seen.some((entry) => entry.method === 'thread/resume')) {
        emit({ method: 'item/completed', params: {
          threadId: 'thread-1', item: { type: 'agentMessage', text: 'resumed' },
        } });
        emit({ method: 'turn/completed', params: {
          threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
        } });
      }
    } else {
      emit({ id, result: {} });
      if (method === 'turn/interrupt') {
        emit({ method: 'turn/completed', params: {
          threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' },
        } });
      }
    }
  });
  const adapter = new CodexAdapter(runner);
  let ready!: (value: ActiveTurnControls) => void;
  const active = new Promise<ActiveTurnControls>((resolve) => { ready = resolve; });
  const running = adapter.runTurn({
    projectPath: process.cwd(), prompt: 'Start', onControls: (controls) => { if (controls) ready(controls); },
  });
  const controls = await active;
  await controls.steer?.('Keep the existing tests');
  await controls.interrupt();
  const interrupted = await running;
  expect(interrupted).toMatchObject({ sessionId: 'thread-1', aborted: true });
  expect(seen.find((entry) => entry.method === 'turn/steer')?.params).toMatchObject({
    threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ text: 'Keep the existing tests' }],
  });
  const resumed = await adapter.runTurn({ projectPath: process.cwd(), sessionId: interrupted.sessionId, prompt: 'Continue' });
  expect(resumed).toMatchObject({ sessionId: 'thread-1', aborted: false, text: 'resumed' });
});

it('keeps a Codex turn running after a retryable provider error', async () => {
  const logs: string[] = [];
  const runner = protocolRunner('codex', 'app-server', ({ id, method }, emit) => {
    if (method === 'initialize') emit({ id, result: {} });
    if (method === 'thread/start') emit({ id, result: { thread: { id: 'thread-1' } } });
    if (method === 'turn/start') {
      emit({ id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'error', params: {
        threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
        error: { message: 'Reconnecting', additionalDetails: 'Model at capacity' },
      } });
      emit({ method: 'item/completed', params: {
        threadId: 'thread-1', item: { type: 'agentMessage', text: 'Hello' },
      } });
      emit({ method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
      } });
    }
  });
  const result = await new CodexAdapter(runner).runTurn({
    projectPath: process.cwd(), prompt: 'Hello', permissionMode: 'read-only',
    onLogLine: (line) => logs.push(line),
  });
  expect(result).toMatchObject({ exitCode: 0, text: 'Hello' });
  expect(logs.map((line) => JSON.parse(line))).toContainEqual({
    type: 'provider.error', message: 'Reconnecting Model at capacity', retrying: true,
  });
});

it('returns a Codex rate limit for read-only fallback', async () => {
  const runner = protocolRunner('codex', 'app-server', ({ id, method }, emit) => {
    if (method === 'initialize') emit({ id, result: {} });
    if (method === 'thread/start') emit({ id, result: { thread: { id: 'thread-1' } } });
    if (method === 'turn/start') {
      emit({ id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'error', params: {
        threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
        error: { message: 'Reconnecting', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } },
      } });
    }
  });
  const result = await new CodexAdapter(runner).runTurn({
    projectPath: process.cwd(), prompt: 'Hello', permissionMode: 'read-only',
  });
  expect(result).toMatchObject({ exitCode: 1, rateLimitReason: 'Codex rate limited the request (HTTP 429).' });
});

it('cancels an ACP prompt and keeps the Antigravity session available to resume', async () => {
  let finish!: (message: unknown) => void;
  let promptId: number | undefined;
  const runner = protocolRunner('agy', 'acp', ({ id, method, params }, emit) => {
    if (method === 'initialize') emit({ id, result: { protocolVersion: 1 } });
    if (method === 'session/new') emit({ id, result: { sessionId: 'agy-1', modes: {} } });
    if (method === 'session/set_mode') emit({ id, result: {} });
    if (method === 'session/prompt') {
      promptId = id;
      finish = emit;
      emit({ method: 'session/update', params: {
        sessionId: 'agy-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'working' } },
      } });
    }
    if (method === 'session/cancel') {
      expect(params.sessionId).toBe('agy-1');
      finish({ id: promptId, result: { stopReason: 'cancelled' } });
    }
  });
  let ready!: (value: ActiveTurnControls) => void;
  const active = new Promise<ActiveTurnControls>((resolve) => { ready = resolve; });
  const adapter = new AntigravityAdapter(runner, { antigravityKeyringAccess: () => false });
  const running = adapter.runTurn({
    projectPath: process.cwd(), prompt: 'Start', onControls: (controls) => { if (controls) ready(controls); },
  });
  const controls = await active;
  expect(controls.steer).toBeUndefined();
  await controls.interrupt();
  expect(await running).toMatchObject({ sessionId: 'agy-1', text: 'working', aborted: true });
});

it('steers and interrupts a Claude session over stream-json input', async () => {
  const written: Record<string, any>[] = [];
  const runner: CliRunner = {
    supportsInteractiveStdin: true,
    async which(name) { return name === 'claude' ? '/usr/bin/claude' : null; },
    async run(_command, args, options) {
      expect(args).toContain('--input-format');
      expect(args).not.toContain('Start');
      return new Promise<RunCommandResult>((resolve) => {
        const emit = (event: unknown) => options.onStdoutLine?.(JSON.stringify(event));
        const finish = () => resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false });
        options.onSpawn?.({
          writeStdin: (data) => {
            const message = JSON.parse(data) as Record<string, any>;
            written.push(message);
            if (written.length === 1) emit({ type: 'system', subtype: 'init', session_id: 'claude-1' });
            if (message.request?.subtype === 'interrupt') {
              emit({ type: 'result', is_error: true, result: 'interrupted', session_id: 'claude-1' });
            }
          },
          endStdin: finish,
          kill: finish,
        });
      });
    },
  };
  let ready!: (value: ActiveTurnControls) => void;
  const active = new Promise<ActiveTurnControls>((resolve) => { ready = resolve; });
  const running = new ClaudeCodeAdapter(runner).runTurn({
    projectPath: process.cwd(), prompt: 'Start', onControls: (controls) => { if (controls) ready(controls); },
  });
  const controls = await active;
  await controls.steer?.('Keep the tests');
  await controls.interrupt();
  expect(await running).toMatchObject({ sessionId: 'claude-1', aborted: true });
  expect(written[0].message.content[0].text).toBe('Start');
  expect(written[1]).toMatchObject({ type: 'user', priority: 'now', message: { content: 'Keep the tests' } });
  expect(written[2]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
});
