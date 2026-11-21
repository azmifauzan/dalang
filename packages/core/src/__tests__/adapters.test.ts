import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sandbox from '../adapters/sandbox.js';
import { AntigravityAdapter, parseAgyModelsOutput, parseAgyUsageJson } from '../adapters/antigravity.js';
import { ClaudeCodeAdapter, parseClaudeUsageText } from '../adapters/claude.js';
import { CodexAdapter, parseCodexRateLimits } from '../adapters/codex.js';
import { wrapWithBwrap } from '../adapters/sandbox.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Provider adapters & bwrap wrapper', () => {
  it('parses agy usage JSON, codex rateLimits, and claude usage text', () => {
    const agyRaw = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.73,
                  reset_time: '2026-11-18T06:15:41Z',
                },
              ],
            },
          ],
        },
      },
    });
    const agyParsed = parseAgyUsageJson(agyRaw);
    expect(agyParsed.ok).toBe(true);
    expect(agyParsed.windows[0]).toMatchObject({
      window: '5h',
      remainingPercent: 73,
      usedPercent: 27,
      resetsAt: '2026-11-18T06:15:41Z',
    });

    expect(parseAgyModelsOutput('Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 (High)\n')).toEqual([
      {
        id: 'gemini-4-hydrogen',
        value: 'gemini-4-hydrogen',
        resolvedModel: 'gemini-4-hydrogen',
        displayName: 'Gemini 4',
        description: '',
        supportedEffortLevels: ['high'],
        defaultEffort: 'high',
        supportsFastMode: false,
        supportsThinking: true,
        variants: [],
      },
    ]);

    const codexWindows = parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1795000000 },
        secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1795500000 },
      },
    });
    expect(codexWindows).toHaveLength(2);
    expect(codexWindows[0]).toMatchObject({ window: '5h', usedPercent: 18, remainingPercent: 82 });
    expect(codexWindows[1]).toMatchObject({ window: 'weekly', usedPercent: 42, remainingPercent: 58 });

    const claudeWindows = parseClaudeUsageText('Current session (5h): 24% used, resets in 2h\nWeekly: 60% remaining');
    expect(claudeWindows).toHaveLength(2);
    expect(claudeWindows[0]).toMatchObject({ window: '5h', usedPercent: 24, remainingPercent: 76 });
    expect(claudeWindows[1]).toMatchObject({ window: 'weekly', usedPercent: 40, remainingPercent: 60 });
  });

  it('wraps commands with bwrap when available and parses stream output across all 3 adapters', async () => {
    const projectDir = makeTempDir('dalang-adp-');
    const calls: Array<{ command: string; args: string[]; opts: RunCommandOptions }> = [];

    const fakeRunner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(command, args, opts): Promise<RunCommandResult> {
        calls.push({ command, args, opts });
        const innerArgs = `${command} ${args.join(' ')}`;
        if (innerArgs.includes('claude')) {
          const line1 = JSON.stringify({ type: 'system', session_id: 'claude-sess-1' });
          const line2 = JSON.stringify({ type: 'result', session_id: 'claude-sess-1', result: 'ok-claude' });
          opts.onStdoutLine?.(line1);
          opts.onStdoutLine?.(line2);
          return { exitCode: 0, stdout: `${line1}\n${line2}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        if (innerArgs.includes('codex')) {
          const line1 = JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-9' });
          const line2 = JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'ok-codex' },
          });
          opts.onStdoutLine?.(line1);
          opts.onStdoutLine?.(line2);
          return { exitCode: 0, stdout: `${line1}\n${line2}\n`, stderr: '', timedOut: false, idleTimedOut: false };
        }
        const agyLine = JSON.stringify({
          type: 'result',
          conversation_id: 'agy-conv-7',
          response: 'ok-agy',
        });
        opts.onStdoutLine?.(agyLine);
        return { exitCode: 0, stdout: `${agyLine}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      },
    };

    const wrapped = await wrapWithBwrap(fakeRunner, 'antigravity', projectDir, '/usr/bin/agy', ['-p=hi']);
    if (process.platform === 'linux') {
      expect(wrapped.sandboxed).toBe(true);
      expect(wrapped.command).toBe('/usr/bin/bwrap');
      expect(wrapped.args).toContain('--tmpfs');
      expect(wrapped.args).toContain(projectDir);
    }

    const claude = new ClaudeCodeAdapter(fakeRunner);
    const r1 = await claude.runTurn({ projectPath: projectDir, prompt: 'hello', sessionId: 'prev-c' });
    expect(r1.sessionId).toBe('claude-sess-1');
    expect(r1.text).toBe('ok-claude');
    expect(calls[0].args.join(' ')).toContain('--resume prev-c');

    const codex = new CodexAdapter(fakeRunner);
    const r2 = await codex.runTurn({ projectPath: projectDir, prompt: 'hello' });
    expect(r2.sessionId).toBe('codex-thread-9');
    expect(r2.text).toBe('ok-codex');

    vi.spyOn(sandbox, 'startDbusProxy').mockResolvedValue({ socketPath: '/tmp/proxy/bus', stop: () => {} });
    const agy = new AntigravityAdapter(fakeRunner, { antigravityKeyringAccess: () => true });
    const r3 = await agy.runTurn({ projectPath: projectDir, prompt: 'hello', sessionId: 'prev-a' });
    expect(r3.sessionId).toBe('agy-conv-7');
    expect(r3.text).toBe('ok-agy');
    expect(calls[2].args.join(' ')).toContain('--conversation prev-a');
    expect(calls[2].args.join(' ')).toContain('-p=hello');

    await claude.runTurn({
      projectPath: projectDir,
      prompt: 'exec',
      permissionMode: 'workspace-write',
    });
    expect(calls[3].args.join(' ')).toContain(
      process.platform === 'linux' ? '--permission-mode bypassPermissions' : '--permission-mode auto',
    );

    await agy.runTurn({
      projectPath: projectDir,
      prompt: 'review',
      permissionMode: 'read-only',
    });
    expect(calls[4].args.join(' ')).toContain('--mode plan');
    if (process.platform === 'linux') {
      expect(calls[4].args.join(' ')).toContain(`--ro-bind ${projectDir} ${projectDir}`);
    }

    await codex.runTurn({
      projectPath: projectDir,
      prompt: 'review',
      permissionMode: 'read-only',
      outputFilePath: path.join(projectDir, '.dalang', 'tmp', 'ignored.txt'),
    });
    if (process.platform === 'linux') {
      expect(calls[5].args.join(' ')).toContain(`--ro-bind ${projectDir} ${projectDir}`);
      expect(calls[5].args.join(' ')).toContain('sandbox_mode="danger-full-access"');
    } else {
      expect(calls[5].args.join(' ')).toContain('sandbox_mode="read-only"');
    }
    expect(calls[5].args).not.toContain('-o');
  });
});

describe('bwrap session bus', () => {
  const runner: CliRunner = {
    async which(bin) {
      return bin === 'bwrap' ? '/usr/bin/bwrap' : null;
    },
    async run(): Promise<RunCommandResult> {
      throw new Error('unused');
    },
  };

  it('hides /run/user for every provider and mounts only the filtered proxy socket as the bus', async () => {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') return;
    const exists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => file === '/run/user' || exists(file));
    const proj = makeTempDir('dalang-bus-proj-');
    const withProxy = await wrapWithBwrap(runner, 'antigravity', proj, '/bin/true', [], { dbusSocket: '/tmp/proxy/bus' });
    const joined = withProxy.args.join(' ');
    expect(joined).toContain('--tmpfs /run/user');
    expect(joined).toContain(`--ro-bind /tmp/proxy/bus /run/user/${process.getuid()}/bus`);
    expect(joined).toContain('DBUS_SESSION_BUS_ADDRESS');

    for (const provider of ['claude-code', 'codex', 'antigravity'] as const) {
      const noBus = await wrapWithBwrap(runner, provider, proj, '/bin/true', []);
      expect(noBus.args.join(' ')).toContain('--tmpfs /run/user');
      expect(noBus.args.join(' ')).not.toContain('/bus');
    }
  });
});

describe('Antigravity keyring opt-in', () => {
  it('refuses a sandboxed run until the keyring opt-in is on, without spawning anything', async () => {
    if (process.platform !== 'linux') return;
    let spawned = 0;
    const runner: CliRunner = {
      async which(bin) {
        return `/usr/bin/${bin}`;
      },
      async run(): Promise<RunCommandResult> {
        spawned += 1;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
      },
    };
    const agy = new AntigravityAdapter(runner);
    await expect(agy.runTurn({ projectPath: makeTempDir('dalang-agy-off-'), prompt: 'x' })).rejects.toThrow(
      /Allow Antigravity to read the desktop keyring/,
    );
    expect(spawned).toBe(0);
  });
});

