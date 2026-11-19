import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '@dalang/shared';
import { NodeCliRunner } from '../adapters/sandbox.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';

export interface ReplayTurnMatch {
  provider?: ProviderId;
  promptContains?: string;
  model?: string;
  configDir?: string;
}

export interface ReplayTurnEntry {
  id?: string;
  match?: ReplayTurnMatch;
  /** Files to write relative to options.cwd when this turn runs (simulating agent file edits). */
  files?: Record<string, string>;
  /** Files to remove relative to options.cwd. */
  deleteFiles?: string[];
  /** Streamed stdout lines (recorded CLI JSONL events). */
  stdoutLines: string[];
  stderrLines?: string[];
  exitCode: number;
  delayMs?: number;
  /** If true, this entry can match more than once. Default false (consumed on match). */
  reusable?: boolean;
}

export interface ReplayTranscript {
  name: string;
  description?: string;
  /** Optional mocked binaries available in PATH (default: claude, codex, agy, bwrap, gh). */
  binaries?: string[];
  /** Optional canned responses for CLI health checks (models, version, auth, usage). */
  health?: {
    claudeVersion?: string;
    claudeAuthJson?: Record<string, unknown>;
    claudeInitializeStdout?: string;
    claudeUsageText?: string;
    codexVersion?: string;
    codexLoginStatus?: string;
    codexModelsJson?: unknown;
    codexRateLimits?: unknown;
    agyVersion?: string;
    agyModelsOutput?: string;
    agyUsageJson?: unknown;
  };
  turns: ReplayTurnEntry[];
}

export interface RecordedInvocation {
  command: string;
  args: string[];
  innerCommand: string;
  innerArgs: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  matchedTurnId?: string;
}

function unwrapSandboxArgs(command: string, args: string[]): { innerCommand: string; innerArgs: string[] } {
  const base = path.basename(command);
  if (base === 'bwrap') {
    const sep = args.indexOf('--');
    if (sep >= 0 && sep + 1 < args.length) {
      return { innerCommand: args[sep + 1], innerArgs: args.slice(sep + 2) };
    }
  }
  if (base === 'sandbox-exec') {
    const pIdx = args.indexOf('-p');
    if (pIdx >= 0 && pIdx + 2 < args.length) {
      return { innerCommand: args[pIdx + 2], innerArgs: args.slice(pIdx + 3) };
    }
  }
  return { innerCommand: command, innerArgs: args };
}

function detectProviderFromCommand(innerCommand: string): ProviderId | null {
  const base = path.basename(innerCommand);
  if (base === 'claude') return 'claude-code';
  if (base === 'codex') return 'codex';
  if (base === 'agy') return 'antigravity';
  return null;
}

function extractPromptAndModel(provider: ProviderId, innerArgs: string[]): { prompt: string; model: string | null } {
  let model: string | null = null;
  let prompt = innerArgs.join(' ');
  for (let i = 0; i < innerArgs.length; i++) {
    const a = innerArgs[i];
    if ((a === '--model' || a === '-m') && innerArgs[i + 1]) {
      model = innerArgs[i + 1];
    }
    if (provider === 'claude-code' && a === '-p' && innerArgs[i + 1]) {
      prompt = innerArgs[i + 1];
    }
    if (provider === 'antigravity' && a.startsWith('-p=')) {
      prompt = a.slice(3);
    }
  }
  if (provider === 'codex' && innerArgs.length > 0) {
    prompt = innerArgs[innerArgs.length - 1];
  }
  return { prompt, model };
}

function extractConfigDir(provider: ProviderId, env?: Record<string, string | undefined>): string | null {
  if (!env) return null;
  if (provider === 'claude-code') return env.CLAUDE_CONFIG_DIR ?? null;
  if (provider === 'codex') return env.CODEX_HOME ?? null;
  return env.AGY_CONFIG_DIR ?? env.XDG_CONFIG_HOME ?? null;
}

export function loadReplayTranscript(filePath: string): ReplayTranscript {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as ReplayTranscript;
}

/**
 * Process-level replay runner: replaces only the external CLI subprocess while the real adapters,
 * normalizers, git worktrees, SQLite database, and orchestrator run unmodified.
 * Shell commands (`/bin/sh -c ...`) run for real via `NodeCliRunner` so `verify` and integration tests execute.
 */
export class ReplayCliRunner implements CliRunner {
  private readonly realRunner = new NodeCliRunner();
  private readonly consumedIndices = new Set<number>();
  private readonly binaries: Set<string>;
  readonly invocations: RecordedInvocation[] = [];

  constructor(
    private readonly transcript: ReplayTranscript,
    private readonly options: {
      runRealShellCommands?: boolean;
      ghPrUrl?: string;
    } = {},
  ) {
    this.binaries = new Set(
      transcript.binaries ?? ['claude', 'codex', 'agy', 'bwrap', 'sandbox-exec', 'gh'],
    );
  }

  async which(binary: string): Promise<string | null> {
    if (!this.binaries.has(binary)) return null;
    if (binary === 'bwrap' || binary === 'sandbox-exec') {
      return `/usr/bin/${binary}`;
    }
    return `/usr/local/bin/${binary}`;
  }

  private tryHandleHealthCheck(
    provider: ProviderId,
    innerArgs: string[],
    options: RunCommandOptions,
  ): RunCommandResult | null {
    const h = this.transcript.health ?? {};
    const joined = innerArgs.join(' ');

    if (innerArgs.includes('--version')) {
      const ver =
        provider === 'claude-code'
          ? (h.claudeVersion ?? '2.1.0 (Claude Code Replay)')
          : provider === 'codex'
            ? (h.codexVersion ?? 'codex-cli 0.169.0 (Replay)')
            : (h.agyVersion ?? 'agy 1.5.10 (Replay)');
      return { exitCode: 0, stdout: `${ver}\n`, stderr: '', timedOut: false, idleTimedOut: false };
    }

    if (provider === 'claude-code') {
      if (innerArgs[0] === 'auth' && innerArgs[1] === 'status') {
        const payload = h.claudeAuthJson ?? {
          loggedIn: true,
          email: 'replay@dalang.local',
          planTier: 'max',
        };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload)}\n`,
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
      if (innerArgs.includes('--bare') && joined.includes('stream-json')) {
        const stdout =
          h.claudeInitializeStdout ??
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: 'dalang-init',
              response: {
                models: [
                  {
                    value: 'opus',
                    resolvedModel: 'claude-opus-5-5',
                    displayName: 'Opus',
                    description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok',
                    supportsEffort: true,
                    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
                    supportsAdaptiveThinking: true,
                    supportsFastMode: true,
                  },
                  {
                    value: 'claude-fable-5-2[1m]',
                    resolvedModel: 'claude-fable-5-2',
                    displayName: 'Fable',
                    description: 'Fable 5.2 · Long context tasks',
                    supportsEffort: true,
                    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
                    supportsAdaptiveThinking: true,
                    supportsFastMode: true,
                  },
                  {
                    value: 'sonnet',
                    resolvedModel: 'claude-sonnet-5-5',
                    displayName: 'Sonnet',
                    description: 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok',
                    supportsEffort: true,
                    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
                    supportsAdaptiveThinking: true,
                  },
                ],
              },
            },
          })}\n`;
        return { exitCode: 0, stdout, stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (innerArgs.includes('/usage')) {
        const text =
          h.claudeUsageText ??
          'Current session (5h): 15% used, resets in 3h\nCurrent week: 22% used, resets in 4d\n';
        return { exitCode: 0, stdout: text, stderr: '', timedOut: false, idleTimedOut: false };
      }
    }

    if (provider === 'codex') {
      if (innerArgs[0] === 'login' && innerArgs[1] === 'status') {
        return {
          exitCode: 0,
          stdout: `${h.codexLoginStatus ?? 'Logged in using ChatGPT'}\n`,
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
      if (innerArgs[0] === 'debug' && innerArgs[1] === 'models') {
        const modelsJson = h.codexModelsJson ?? {
          models: [
            {
              slug: 'gpt-6.2-sol',
              display_name: 'GPT-6.2-Sol',
              description: 'Fast, go-to model for coding and everyday work.',
              visibility: 'list',
              default_reasoning_level: 'low',
              supported_reasoning_levels: [
                { effort: 'low' },
                { effort: 'medium' },
                { effort: 'high' },
                { effort: 'xhigh' },
                { effort: 'max' },
              ],
            },
          ],
        };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(modelsJson)}\n`,
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
      if (innerArgs[0] === 'app-server') {
        const rl = h.codexRateLimits ?? {
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300 },
            secondary: { usedPercent: 25, windowDurationMins: 10080 },
          },
        };
        const line1 = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
        const line2 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: rl });
        options.onStdoutLine?.(line1);
        options.onStdoutLine?.(line2);
        return {
          exitCode: 0,
          stdout: `${line1}\n${line2}\n`,
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
    }

    if (provider === 'antigravity') {
      if (innerArgs[0] === 'models') {
        const out =
          h.agyModelsOutput ??
          [
            'Fetching available models...',
            'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
            'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
            'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
            'gemini-4-neon-high\tGemini 4 Neon (High)',
            'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
          ].join('\n');
        return { exitCode: 0, stdout: `${out}\n`, stderr: '', timedOut: false, idleTimedOut: false };
      }
      if (innerArgs.some((a) => a === '-p=/usage')) {
        const usageJson = h.agyUsageJson ?? {
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
                      remaining_fraction: 0.85,
                    },
                  ],
                },
              ],
            },
          },
        };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(usageJson)}\n`,
          stderr: '',
          timedOut: false,
          idleTimedOut: false,
        };
      }
    }

    return null;
  }

  async run(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult> {
    if (options.signal?.aborted) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
    }

    const { innerCommand, innerArgs } = unwrapSandboxArgs(command, args);
    const base = path.basename(innerCommand);

    // Run real shell verify / integration commands directly in cwd (without bwrap overhead in test harness).
    if ((base === 'sh' || innerCommand === '/bin/sh') && this.options.runRealShellCommands !== false) {
      this.invocations.push({ command, args, innerCommand, innerArgs, cwd: options.cwd, env: options.env });
      return this.realRunner.run(innerCommand, innerArgs, options);
    }

    if (base === 'gh') {
      this.invocations.push({ command, args, innerCommand, innerArgs, cwd: options.cwd, env: options.env });
      const url = this.options.ghPrUrl ?? 'https://github.com/example/repo/pull/42';
      options.onStdoutLine?.(url);
      return { exitCode: 0, stdout: `${url}\n`, stderr: '', timedOut: false, idleTimedOut: false };
    }

    const provider = detectProviderFromCommand(innerCommand);
    if (!provider) {
      this.invocations.push({ command, args, innerCommand, innerArgs, cwd: options.cwd, env: options.env });
      return {
        exitCode: 1,
        stdout: '',
        stderr: `ReplayCliRunner: unexpected command ${innerCommand}`,
        timedOut: false,
        idleTimedOut: false,
      };
    }

    const healthReply = this.tryHandleHealthCheck(provider, innerArgs, options);
    if (healthReply) {
      this.invocations.push({ command, args, innerCommand, innerArgs, cwd: options.cwd, env: options.env });
      return healthReply;
    }

    const { prompt, model } = extractPromptAndModel(provider, innerArgs);
    const configDir = extractConfigDir(provider, options.env);

    const matchedIndex = this.transcript.turns.findIndex((turn, idx) => {
      if (!turn.reusable && this.consumedIndices.has(idx)) return false;
      const m = turn.match;
      if (!m) return true;
      if (m.provider && m.provider !== provider) return false;
      if (m.model && m.model !== model) return false;
      if (m.configDir && m.configDir !== configDir) return false;
      if (m.promptContains && !prompt.includes(m.promptContains)) return false;
      return true;
    });

    if (matchedIndex < 0) {
      this.invocations.push({ command, args, innerCommand, innerArgs, cwd: options.cwd, env: options.env });
      return {
        exitCode: 1,
        stdout: '',
        stderr: `ReplayCliRunner: no transcript turn matched provider=${provider} model=${model ?? ''} prompt=${prompt.slice(0, 120)}`,
        timedOut: false,
        idleTimedOut: false,
      };
    }

    const turn = this.transcript.turns[matchedIndex];
    if (!turn.reusable) {
      this.consumedIndices.add(matchedIndex);
    }

    this.invocations.push({
      command,
      args,
      innerCommand,
      innerArgs,
      cwd: options.cwd,
      env: options.env,
      matchedTurnId: turn.id ?? `turn-${matchedIndex}`,
    });

    if (turn.delayMs && turn.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    }
    if (options.signal?.aborted) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
    }

    if (turn.files) {
      for (const [relPath, content] of Object.entries(turn.files)) {
        const abs = path.resolve(options.cwd, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }
    }
    if (turn.deleteFiles) {
      for (const relPath of turn.deleteFiles) {
        fs.rmSync(path.resolve(options.cwd, relPath), { force: true });
      }
    }

    for (const line of turn.stdoutLines) {
      options.onStdoutLine?.(line);
    }
    for (const line of turn.stderrLines ?? []) {
      options.onStderrLine?.(line);
    }

    return {
      exitCode: turn.exitCode,
      stdout: `${turn.stdoutLines.join('\n')}\n`,
      stderr: turn.stderrLines ? `${turn.stderrLines.join('\n')}\n` : '',
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    };
  }
}
