import { describe, expect, it } from 'vitest';
import { NodeCliRunner } from '../adapters/sandbox.js';
import { turnRunner, withSessionRpc } from '../adapters/session-rpc.js';
import type { CliRunner } from '../adapters/types.js';
import { CodexAdapter } from '../adapters/codex.js';
import { AntigravityAdapter } from '../adapters/antigravity.js';

const cwd = process.cwd();
const runner = new NodeCliRunner();

describe('fatal stderr (R2, B1)', () => {
  it.each([
    ['codex', "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces", 'Codex cannot create'],
    ['codex', 'bwrap: No permissions to create a new namespace', 'Bubblewrap cannot create'],
    ['codex', 'bwrap: Unknown option --bad', 'origin is unconfirmed'],
  ] as const)('stops %s promptly for %s', async (provider, line, hint) => {
    const start = Date.now();
    const script = `console.error(${JSON.stringify(line)}); setInterval(() => {}, 1000)`;
    await expect(turnRunner(runner, provider).run(process.execPath, ['-e', script], { cwd, timeoutMs: 5000 })).rejects.toThrow(hint);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it.each([
    ['antigravity', 'MCP server github: authentication required'],
    ['antigravity', 'cache not authenticated, retrying'],
    ['claude', 'MCP server: Invalid API key, retrying'],
    ['claude', 'Warning: Invalid API key for optional plugin'],
  ] as const)('allows unrelated %s authentication warnings', async (provider, line) => {
    const result = await turnRunner(runner, provider).run(process.execPath, ['-e', `console.error(${JSON.stringify(line)}); console.log('ok')`], { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it.each([['bwrap', 'DALANG bubblewrap configuration'], ['none', 'origin is unconfirmed']] as const)('reports bwrap option origin for %s', async (engine, expected) => {
    await expect(turnRunner(runner, 'codex', [], engine).run(process.execPath, ['-e', "console.error('bwrap: Unknown option --bad'); setInterval(() => {}, 1000)"], { cwd })).rejects.toThrow(expected);
  });

  it('redacts credential shapes and short known secrets from errors', async () => {
    const line = 'Authorization: Bearer abcdef; sk-example123 https://host/path?access_token=oauth123&api_key=key123 shortsecret=xyz';
    const promise = turnRunner(runner, 'codex', ['xyz']).run(process.execPath, ['-e', `console.error(${JSON.stringify(line)}); setInterval(() => {}, 1000)`], { cwd, timeoutMs: 150 });
    const error = await promise.then(() => { throw new Error('Expected timeout'); }, (e: Error) => e);
    expect(error.message).toContain('[REDACTED]');
    for (const secret of ['abcdef', 'sk-example123', 'oauth123', 'key123', 'xyz']) expect(error.message).not.toContain(secret);
  });

  it('does not append stderr twice to an RPC fatal error', async () => {
    const script = `process.stderr.write("Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces\\r\\n"); setInterval(() => {}, 1000)`;
    const error = await withSessionRpc(turnRunner(runner, 'codex'), process.execPath, ['-e', script], { cwd }, () => {}, async (rpc) => rpc.request('initialize')).then(() => { throw new Error('Expected fatal stderr'); }, (e: Error) => e);
    expect(error.message.match(/Stderr:/g)).toHaveLength(1);
  });

  it('allows a nonfatal warning and preserves successful output', async () => {
    const result = await turnRunner(runner, 'codex').run(process.execPath, ['-e', "console.error('warning'); console.log('ok')"], { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok');
    expect(result.stderr).toContain('warning');
  });

  it('detects a fatal pattern split across chunks without a newline', async () => {
    const script = `process.stderr.write("Codex's Linux sandbox uses bubblewrap "); setTimeout(() => process.stderr.write('and needs access to create user namespaces'), 20); setInterval(() => {}, 1000)`;
    await expect(turnRunner(runner, 'codex').run(process.execPath, ['-e', script], { cwd, timeoutMs: 3000 })).rejects.toThrow('Codex cannot create');
  });

  it('includes a bounded redacted tail on timeout and exit', async () => {
    const secret = 'secret-token-123456';
    const script = `process.stderr.write('x'.repeat(6000) + ${JSON.stringify(secret)} + '\\n'); setInterval(() => {}, 1000)`;
    await expect(turnRunner(runner, 'codex', [secret]).run(process.execPath, ['-e', script], { cwd, timeoutMs: 150 })).rejects.toThrow(/timed out.*\nStderr: x+\[REDACTED\]/);
    const result = await turnRunner(runner, 'codex', [secret]).run(process.execPath, ['-e', `console.error('x'.repeat(6000) + ${JSON.stringify(secret)}); process.exit(1)`], { cwd });
    expect(result.stderr.length).toBeLessThanOrEqual(4000);
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stderr).not.toContain(secret);
  });

  it('propagates a fatal error during RPC initialization without waiting for the session', async () => {
    const fake: CliRunner = {
      supportsInteractiveStdin: true,
      which: async () => 'fake',
      run: async (_command, _args, options) => {
        options.onSpawn?.({ writeStdin() {}, endStdin() {}, kill() {} });
        options.onStderrLine?.("Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces");
        return new Promise(() => {});
      },
    };
    await expect(withSessionRpc(turnRunner(fake, 'codex'), 'fake', [], { cwd }, () => {}, async (rpc) => rpc.request('initialize'))).rejects.toThrow('Codex cannot create');
  });
});

function sessionRunner(provider: 'codex' | 'antigravity', afterSubmit: boolean, timeout: boolean): CliRunner {
  return {
    supportsInteractiveStdin: true,
    which: async (binary) => (binary === 'codex' || binary === 'agy' ? binary : null),
    run: async (_command, args, options) => {
      const session = args.includes('app-server') || args.includes('acp');
      const result = { exitCode: 1, stdout: '', stderr: 'provider diagnostic', timedOut: timeout, idleTimedOut: false };
      if (!session) {
        const line = provider === 'codex'
          ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fallback' } })
          : JSON.stringify({ type: 'result', response: 'fallback' });
        options.onStdoutLine?.(line);
        return { ...result, exitCode: 0, timedOut: false, stderr: '' };
      }
      return new Promise((resolve) => {
        const emit = (value: object) => options.onStdoutLine?.(JSON.stringify(value));
        const finish = () => { options.onStderrLine?.('provider diagnostic'); resolve(result); };
        options.onSpawn?.({
          endStdin() {}, kill: finish,
          writeStdin(data) {
            const request = JSON.parse(data) as { id?: number; method: string };
            if (!request.id) return;
            queueMicrotask(() => {
              if (!afterSubmit) return finish();
              if (request.method === 'initialize') emit({ id: request.id, result: provider === 'codex' ? {} : { protocolVersion: 1 } });
              else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'session-1' } } });
              else if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'session-1', configOptions: [{ category: 'mode', id: 'mode', currentValue: 'accept-edits' }] } });
              else if (request.method === 'turn/start') {
                emit({ id: request.id, result: { turn: { id: 'turn-1' } } });
                emit({ method: 'item/completed', params: { threadId: 'session-1', item: { type: 'agentMessage', text: 'partial' } } });
                emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'session-1', tokenUsage: { last: { inputTokens: 7 } } } });
                emit({ method: 'error', params: { threadId: 'session-1', error: { message: 'provider detail' } } });
                finish();
              } else if (request.method === 'session/prompt') {
                emit({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'partial' }, usage: { inputTokens: 7 } } } });
                finish();
              }
            });
          },
        });
      });
    },
  };
}

describe.each(['codex', 'antigravity'] as const)('%s session failures', (provider) => {
  const adapter = (afterSubmit: boolean, timeout: boolean) => provider === 'codex'
    ? new CodexAdapter(sessionRunner(provider, afterSubmit, timeout))
    : new AntigravityAdapter(sessionRunner(provider, afterSubmit, timeout), { antigravityKeyringAccess: () => false });
  it.each([false, true])('falls back before submission on timeout=%s', async (timeout) => {
    const result = await adapter(false, timeout).runTurn({ projectPath: cwd, prompt: 'hello' });
    expect(result.text).toBe('fallback');
    expect(result.exitCode).toBe(0);
  });
  it.each([false, true])('preserves partial results after submission on timeout=%s', async (timeout) => {
    const result = await adapter(true, timeout).runTurn({ projectPath: cwd, prompt: 'hello' });
    expect(result).toMatchObject({ exitCode: 1, text: 'partial', sessionId: 'session-1', usage: { inputTokens: 7 } });
    expect(result.stderr).toContain('provider diagnostic');
    if (provider === 'codex') expect(result.stderr).toContain('provider detail');
  });
});
