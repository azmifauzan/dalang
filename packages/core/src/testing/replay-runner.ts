import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderId } from '@dalang/shared';
import { NodeCliRunner } from '../adapters/sandbox.js';
import type { CliRunner, RunCommandOptions, RunCommandResult } from '../adapters/types.js';
import {
  getProviderReplayDynamicFields,
  ReplayMessageMatcher,
} from './replay-matching.js';

export type ReplayScriptEntry =
  | {
      type: 'expect_outbound';
      frame: unknown;
    }
  | {
      type: 'emit_inbound';
      frame: unknown;
      afterMs?: number;
    }
  | {
      type: 'exit';
      exitCode: number | null;
      timedOut?: boolean;
      idleTimedOut?: boolean;
      aborted?: boolean;
    };

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
  /** Streamed stdout lines (recorded CLI JSONL events). Optional when `entries` is provided. */
  stdoutLines?: string[];
  stderrLines?: string[];
  exitCode?: number;
  delayMs?: number;
  /** If true, this entry can match more than once. Default false (consumed on match). */
  reusable?: boolean;
  /** Linear interactive replay script (`expect_outbound`, `emit_inbound`, `exit`). */
  entries?: ReplayScriptEntry[];
}

export interface ReplayCliRunnerOptions {
  runRealShellCommands?: boolean;
  ghPrUrl?: string;
  /** Override `supportsInteractiveStdin` (defaults to `true` when any transcript turn has `entries`). */
  supportsInteractiveStdin?: boolean;
  /** Optional per-step timeout (ms) when waiting for an `expect_outbound` frame. */
  expectOutboundTimeoutMs?: number;
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

export function unwrapSandboxArgs(command: string, args: string[]): { innerCommand: string; innerArgs: string[] } {
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

export function detectProviderFromCommand(innerCommand: string): ProviderId | null {
  const base = path.basename(innerCommand);
  if (base === 'claude') return 'claude-code';
  if (base === 'codex') return 'codex';
  if (base === 'agy') return 'antigravity';
  return null;
}

export function extractPromptAndModel(provider: ProviderId, innerArgs: string[]): { prompt: string; model: string | null } {
  let model: string | null = null;
  let prompt = innerArgs.join(' ');
  for (let i = 0; i < innerArgs.length; i++) {
    const a = innerArgs[i];
    if ((a === '--model' || a === '-m') && innerArgs[i + 1]) {
      model = innerArgs[i + 1];
    }
    if (provider === 'claude-code' && a === '-p' && innerArgs[i + 1] && !innerArgs[i + 1].startsWith('-')) {
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

function isInteractiveTurn(
  turn: ReplayTurnEntry,
): turn is ReplayTurnEntry & { entries: ReplayScriptEntry[] } {
  return Array.isArray(turn.entries);
}

type SpawnControls = Parameters<NonNullable<RunCommandOptions['onSpawn']>>[0];

function extractPromptFromStdin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.type === 'user' && parsed.message && typeof parsed.message === 'object') {
        const content = (parsed.message as { content?: unknown }).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          const texts = content
            .filter(
              (block): block is { type?: string; text: string } =>
                Boolean(block) &&
                typeof block === 'object' &&
                typeof (block as { text?: unknown }).text === 'string',
            )
            .map((block) => block.text);
          if (texts.length > 0) return texts.join('\n');
        }
      }
    }
  } catch {
    // Fall back to raw stdin text
  }
  return trimmed;
}

function waitDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function applyTurnFiles(turn: ReplayTurnEntry, cwd: string, promptHint: string): void {
  if (turn.files) {
    const sessionMatch = promptHint.match(/\.dalang\/sessions\/([A-Za-z0-9_-]+)\//);
    const sessionIdFromPrompt = sessionMatch?.[1] ?? null;
    for (const [rawRelPath, content] of Object.entries(turn.files)) {
      const relPath =
        sessionIdFromPrompt &&
        rawRelPath.startsWith('.dalang/') &&
        !rawRelPath.startsWith('.dalang/sessions/')
          ? `.dalang/sessions/${sessionIdFromPrompt}/${rawRelPath.slice('.dalang/'.length)}`
          : rawRelPath;
      const abs = path.resolve(cwd, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
  }
  if (turn.deleteFiles) {
    for (const relPath of turn.deleteFiles) {
      fs.rmSync(path.resolve(cwd, relPath), { force: true });
    }
  }
}

function isJsonStringLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function scriptMentionsText(entries: ReplayScriptEntry[], needle: string): boolean {
  for (const entry of entries) {
    if (entry.type === 'exit') continue;
    const text = typeof entry.frame === 'string' ? entry.frame : JSON.stringify(entry.frame);
    if (text.includes(needle)) return true;
  }
  return false;
}

/**
 * Process-level replay runner: replaces only the external CLI subprocess while the real adapters,
 * normalizers, git worktrees, SQLite database, and orchestrator run unmodified.
 * Shell commands (`/bin/sh -c ...`) run for real via `NodeCliRunner` so `verify` and integration tests execute.
 */
export class ReplayCliRunner implements CliRunner {
  readonly supportsInteractiveStdin: boolean;
  private readonly realRunner = new NodeCliRunner();
  private readonly consumedIndices = new Set<number>();
  private readonly binaries: Set<string>;
  readonly invocations: RecordedInvocation[] = [];

  constructor(
    private readonly transcript: ReplayTranscript,
    private readonly options: ReplayCliRunnerOptions = {},
  ) {
    this.supportsInteractiveStdin =
      options.supportsInteractiveStdin ?? transcript.turns.some((turn) => isInteractiveTurn(turn));
    this.binaries = new Set(
      transcript.binaries ?? ['claude', 'codex', 'agy', 'bwrap', 'sandbox-exec', 'gh'],
    );
  }

  private findMatchingUnconsumedInteractiveTurn(
    provider: ProviderId,
    env?: Record<string, string | undefined>,
  ): (ReplayTurnEntry & { entries: ReplayScriptEntry[] }) | undefined {
    const configDir = extractConfigDir(provider, env);
    for (let idx = 0; idx < this.transcript.turns.length; idx++) {
      const turn = this.transcript.turns[idx];
      if (!turn.reusable && this.consumedIndices.has(idx)) continue;
      if (!isInteractiveTurn(turn)) continue;
      const m = turn.match;
      if (m?.provider && m.provider !== provider) continue;
      if (m?.configDir && m.configDir !== configDir) continue;
      return turn;
    }
    return undefined;
  }

  private hasUnconsumedLegacyTurn(
    provider: ProviderId,
    env?: Record<string, string | undefined>,
  ): boolean {
    const configDir = extractConfigDir(provider, env);
    for (let idx = 0; idx < this.transcript.turns.length; idx++) {
      const turn = this.transcript.turns[idx];
      if (!turn.reusable && this.consumedIndices.has(idx)) continue;
      if (isInteractiveTurn(turn)) continue;
      const m = turn.match;
      if (m?.provider && m.provider !== provider) continue;
      if (m?.configDir && m.configDir !== configDir) continue;
      return true;
    }
    return false;
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
        const interactiveTurn = this.findMatchingUnconsumedInteractiveTurn('codex', options.env);
        const looksLikeUsageProbe =
          !options.signal &&
          !options.onStderrLine &&
          options.cwd === os.tmpdir() &&
          options.timeoutMs === 8000 &&
          options.idleTimeoutMs === 5000 &&
          innerArgs.length === 1;
        const interactiveExpectsRateLimits =
          interactiveTurn !== undefined &&
          scriptMentionsText(interactiveTurn.entries, 'account/rateLimits/read');

        if (!this.supportsInteractiveStdin || (looksLikeUsageProbe && !interactiveExpectsRateLimits)) {
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
    if ((base === 'sh' || base.toLowerCase() === 'cmd.exe' || innerCommand === '/bin/sh') && this.options.runRealShellCommands !== false) {
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

    const { prompt: argvPrompt, model } = extractPromptAndModel(provider, innerArgs);
    const configDir = extractConfigDir(provider, options.env);
    const hasStdinPipe = Boolean(
      options.interactiveStdin || options.onSpawn || options.stdinData !== undefined,
    );
    const isProtocolOnlyCall =
      (provider === 'codex' && innerArgs[0] === 'app-server') ||
      (provider === 'antigravity' && innerArgs[0] === 'acp');

    // In mixed transcripts, Claude's interactive session path sends the initial prompt through
    // onSpawn().writeStdin() rather than argv. Buffer synchronous spawn writes once so turn
    // selection can match legacy Claude turns (including promptContains) without double-spawning.
    let spawnProxy:
      | {
          attach: (controls: SpawnControls) => void;
          killed: () => boolean;
        }
      | undefined;
    let stdinPromptSource = options.stdinData ?? '';
    if (!isProtocolOnlyCall && options.onSpawn && this.hasUnconsumedLegacyTurn(provider, options.env)) {
      let delegate: SpawnControls | null = null;
      const bufferedWrites: string[] = [];
      let bufferedEnded = false;
      let bufferedKilled = false;
      const proxyControls: SpawnControls = {
        writeStdin: (data) => {
          if (delegate) delegate.writeStdin(data);
          else if (!bufferedEnded && !bufferedKilled) bufferedWrites.push(data);
        },
        endStdin: () => {
          if (delegate) delegate.endStdin();
          else bufferedEnded = true;
        },
        kill: () => {
          if (delegate) delegate.kill();
          else bufferedKilled = true;
        },
      };
      options.onSpawn(proxyControls);
      stdinPromptSource = `${bufferedWrites.join('')}${options.stdinData ?? ''}`;
      spawnProxy = {
        attach: (realControls) => {
          delegate = realControls;
          for (const chunk of bufferedWrites) {
            realControls.writeStdin(chunk);
          }
          if (bufferedEnded) realControls.endStdin();
          if (bufferedKilled) realControls.kill();
        },
        killed: () => bufferedKilled,
      };
    }

    const promptFromStdin = extractPromptFromStdin(stdinPromptSource);
    const prompt = promptFromStdin ?? argvPrompt;

    const matchedIndex = this.transcript.turns.findIndex((turn, idx) => {
      if (!turn.reusable && this.consumedIndices.has(idx)) return false;
      const interactiveTurn = isInteractiveTurn(turn);
      if (isProtocolOnlyCall && !interactiveTurn) return false;
      if (!hasStdinPipe && interactiveTurn) return false;
      const m = turn.match;
      if (!m) return true;
      if (m.provider && m.provider !== provider) return false;
      if (m.model && m.model !== model) return false;
      if (m.configDir && m.configDir !== configDir) return false;
      if (m.promptContains) {
        if (!interactiveTurn || promptFromStdin !== null) {
          if (!prompt.includes(m.promptContains)) return false;
        }
      }
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
      const completed = await waitDelay(turn.delayMs, options.signal);
      if (!completed) {
        return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
      }
    }
    if (options.signal?.aborted) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, idleTimedOut: false, aborted: true };
    }

    if (isInteractiveTurn(turn)) {
      return this.runInteractiveTurn(provider, turn, options, spawnProxy?.attach);
    }

    if (spawnProxy?.killed()) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        idleTimedOut: false,
        aborted: Boolean(options.signal?.aborted),
      };
    }

    applyTurnFiles(turn, options.cwd, prompt);

    const stdoutLines = turn.stdoutLines ?? [];
    for (const line of stdoutLines) {
      options.onStdoutLine?.(line);
    }
    for (const line of turn.stderrLines ?? []) {
      options.onStderrLine?.(line);
    }

    return {
      exitCode: turn.exitCode ?? 0,
      stdout: `${stdoutLines.join('\n')}\n`,
      stderr: turn.stderrLines ? `${turn.stderrLines.join('\n')}\n` : '',
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    };
  }

  /**
   * Executes a linear interactive session script (`expect_outbound`, `emit_inbound`, `exit`) in strict
   * order following T3 Code's replay runner design, validating outbound frames with bounded per-provider
   * ID normalization and guaranteeing timer cleanup on every exit path.
   */
  private runInteractiveTurn(
    provider: ProviderId,
    turn: ReplayTurnEntry & { entries: ReplayScriptEntry[] },
    options: RunCommandOptions,
    attachSpawnProxy?: (controls: SpawnControls) => void,
  ): Promise<RunCommandResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        idleTimedOut: false,
        aborted: true,
      });
    }

    return new Promise<RunCommandResult>((resolve, reject) => {
      const entries = turn.entries;
      const matcher = new ReplayMessageMatcher({
        dynamicFields: getProviderReplayDynamicFields(provider),
      });

      let cursor = 0;
      const outboundQueue: string[] = [];
      let stdinRemainder = '';
      let stdinEnded = false;
      let settled = false;
      let advancing = false;
      let filesApplied = false;
      let firstOutboundRaw = '';
      let turnStderrEmitted = false;
      let waitingForEmitTimer = false;
      let pendingExitEntry: Extract<ReplayScriptEntry, { type: 'exit' }> | null = null;
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const activeTimers = new Set<ReturnType<typeof setTimeout>>();
      let totalTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let expectOutboundTimer: ReturnType<typeof setTimeout> | null = null;
      let emitTimer: ReturnType<typeof setTimeout> | null = null;
      let exitTimer: ReturnType<typeof setTimeout> | null = null;

      const scheduleTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(() => {
          activeTimers.delete(timer);
          fn();
        }, ms);
        activeTimers.add(timer);
        return timer;
      };

      const cancelTimer = (timer: ReturnType<typeof setTimeout> | null): void => {
        if (timer) {
          clearTimeout(timer);
          activeTimers.delete(timer);
        }
      };

      const onAbort = () => {
        finish({ exitCode: null, aborted: true });
      };

      const cleanup = () => {
        for (const timer of activeTimers) {
          clearTimeout(timer);
        }
        activeTimers.clear();
        totalTimer = null;
        idleTimer = null;
        expectOutboundTimer = null;
        emitTimer = null;
        exitTimer = null;
        options.signal?.removeEventListener('abort', onAbort);
      };

      const emitDiagnostic = (message: string) => {
        stderrLines.push(message);
        options.onStderrLine?.(message);
      };

      const emitTurnStderr = () => {
        if (turnStderrEmitted) return;
        turnStderrEmitted = true;
        for (const line of turn.stderrLines ?? []) {
          stderrLines.push(line);
          options.onStderrLine?.(line);
        }
      };

      const ensureFilesApplied = () => {
        if (filesApplied) return;
        filesApplied = true;
        applyTurnFiles(turn, options.cwd, firstOutboundRaw);
      };

      const finish = (overrides: {
        exitCode: number | null;
        timedOut?: boolean;
        idleTimedOut?: boolean;
        aborted?: boolean;
      }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode: overrides.exitCode,
          stdout: stdoutLines.length > 0 ? `${stdoutLines.join('\n')}\n` : '',
          stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
          timedOut: Boolean(overrides.timedOut),
          idleTimedOut: Boolean(overrides.idleTimedOut),
          aborted: Boolean(overrides.aborted),
        });
      };

      const failScript = (message: string) => {
        if (settled) return;
        emitDiagnostic(message);
        finish({ exitCode: 1 });
      };

      const idleMs = options.idleTimeoutMs ?? 0;
      const totalMs = options.timeoutMs ?? 0;
      const expectOutboundMs = this.options.expectOutboundTimeoutMs ?? 0;

      const resetIdle = () => {
        cancelTimer(idleTimer);
        idleTimer = null;
        if (settled || idleMs <= 0) return;
        idleTimer = scheduleTimer(() => {
          idleTimer = null;
          const waitingNote =
            cursor < entries.length && entries[cursor].type === 'expect_outbound'
              ? ` while waiting for expect_outbound at entry ${cursor}`
              : '';
          emitDiagnostic(`ReplayCliRunner: idle timed out after ${idleMs}ms${waitingNote}`);
          finish({ exitCode: null, idleTimedOut: true });
        }, idleMs);
      };

      if (totalMs > 0) {
        totalTimer = scheduleTimer(() => {
          totalTimer = null;
          const waitingNote =
            cursor < entries.length && entries[cursor].type === 'expect_outbound'
              ? ` while waiting for expect_outbound at entry ${cursor}`
              : '';
          emitDiagnostic(`ReplayCliRunner: timed out after ${totalMs}ms${waitingNote}`);
          finish({ exitCode: null, timedOut: true });
        }, totalMs);
      }

      resetIdle();
      options.onKeepAlive?.(() => {
        if (!settled) resetIdle();
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const matchExpectedOutbound = (
        expectedFrame: unknown,
        actualLine: string,
        entryIndex: number,
      ): { matched: boolean; diagnosis: string } => {
        if (typeof expectedFrame === 'string' && !isJsonStringLiteral(expectedFrame)) {
          if (actualLine.trim() !== expectedFrame.trim()) {
            return {
              matched: false,
              diagnosis: `value_mismatch at [${entryIndex}] (stdin) (root): Raw text frame differs`,
            };
          }
          return { matched: true, diagnosis: 'Matched' };
        }
        const res = matcher.matchMessage(expectedFrame, actualLine, {
          direction: 'stdin',
          messageIndex: entryIndex,
        });
        return { matched: res.matched, diagnosis: res.diagnosis };
      };

      const serializeInboundFrame = (frame: unknown): string => {
        if (typeof frame === 'string') {
          if (isJsonStringLiteral(frame)) {
            const parsed = JSON.parse(frame) as unknown;
            const rewritten = matcher.rewriteCorrelatedFrame(parsed, { direction: 'stdout' });
            return JSON.stringify(rewritten);
          }
          return frame;
        }
        const rewritten = matcher.rewriteCorrelatedFrame(frame, { direction: 'stdout' });
        return JSON.stringify(rewritten);
      };

      const completeAtExit = (exitEntry: Extract<ReplayScriptEntry, { type: 'exit' }>) => {
        if (outboundQueue.length > 0) {
          failScript(
            `ReplayCliRunner: unexpected outbound frame at entry ${cursor} (${outboundQueue.length} extra frame(s) after script completed)`,
          );
          return;
        }
        ensureFilesApplied();
        emitTurnStderr();
        pendingExitEntry = exitEntry;
        if (stdinEnded) {
          cancelTimer(exitTimer);
          exitTimer = null;
          finish({
            exitCode: exitEntry.exitCode,
            timedOut: exitEntry.timedOut,
            idleTimedOut: exitEntry.idleTimedOut,
            aborted: exitEntry.aborted,
          });
          return;
        }
        if (!exitTimer) {
          exitTimer = scheduleTimer(() => {
            exitTimer = null;
            if (outboundQueue.length > 0) {
              failScript(
                `ReplayCliRunner: unexpected outbound frame at entry ${cursor} (${outboundQueue.length} extra frame(s) after script completed)`,
              );
              return;
            }
            finish({
              exitCode: exitEntry.exitCode,
              timedOut: exitEntry.timedOut,
              idleTimedOut: exitEntry.idleTimedOut,
              aborted: exitEntry.aborted,
            });
          }, 0);
        }
      };

      const advance = () => {
        if (advancing || settled || waitingForEmitTimer) return;
        advancing = true;
        try {
          while (!settled && !waitingForEmitTimer) {
            if (pendingExitEntry) {
              if (outboundQueue.length > 0) {
                cancelTimer(exitTimer);
                exitTimer = null;
                failScript(
                  `ReplayCliRunner: unexpected outbound frame at entry ${cursor} (${outboundQueue.length} extra frame(s) after script completed)`,
                );
                return;
              }
              if (stdinEnded) {
                const exitEntry = pendingExitEntry;
                cancelTimer(exitTimer);
                exitTimer = null;
                finish({
                  exitCode: exitEntry.exitCode,
                  timedOut: exitEntry.timedOut,
                  idleTimedOut: exitEntry.idleTimedOut,
                  aborted: exitEntry.aborted,
                });
              }
              return;
            }

            if (cursor >= entries.length) {
              failScript(`ReplayCliRunner: script ended without exit at entry ${cursor}`);
              return;
            }

            const entry = entries[cursor];
            if (!entry || typeof entry !== 'object') {
              failScript(`ReplayCliRunner: invalid script entry at ${cursor}`);
              return;
            }

            if (entry.type === 'expect_outbound') {
              if (outboundQueue.length === 0) {
                if (stdinEnded) {
                  failScript(
                    `ReplayCliRunner: missing expected outbound frame at entry ${cursor} (stdin closed before script completed)`,
                  );
                  return;
                }
                if (!expectOutboundTimer && expectOutboundMs > 0) {
                  expectOutboundTimer = scheduleTimer(() => {
                    expectOutboundTimer = null;
                    emitDiagnostic(
                      `ReplayCliRunner: timed out waiting for expect_outbound at entry ${cursor} after ${expectOutboundMs}ms`,
                    );
                    finish({ exitCode: null, timedOut: true });
                  }, expectOutboundMs);
                }
                return;
              }

              cancelTimer(expectOutboundTimer);
              expectOutboundTimer = null;

              const actualLine = outboundQueue.shift()!;
              if (!firstOutboundRaw) firstOutboundRaw = actualLine;
              const check = matchExpectedOutbound(entry.frame, actualLine, cursor);
              if (!check.matched) {
                failScript(`ReplayCliRunner: outbound frame mismatch at entry ${cursor}: ${check.diagnosis}`);
                return;
              }
              cursor += 1;
              continue;
            }

            if (entry.type === 'emit_inbound') {
              if (outboundQueue.length > 0) {
                failScript(`ReplayCliRunner: unexpected outbound frame before emit_inbound at entry ${cursor}`);
                return;
              }
              const emitNow = () => {
                if (settled) return;
                if (outboundQueue.length > 0) {
                  failScript(`ReplayCliRunner: unexpected outbound frame before emit_inbound at entry ${cursor}`);
                  return;
                }
                ensureFilesApplied();
                const line = serializeInboundFrame(entry.frame);
                stdoutLines.push(line);
                cursor += 1;
                resetIdle();
                options.onStdoutLine?.(line);
              };

              if (
                typeof entry.afterMs === 'number' &&
                Number.isFinite(entry.afterMs) &&
                entry.afterMs > 0
              ) {
                waitingForEmitTimer = true;
                emitTimer = scheduleTimer(() => {
                  emitTimer = null;
                  waitingForEmitTimer = false;
                  if (settled) return;
                  advancing = true;
                  try {
                    emitNow();
                  } finally {
                    advancing = false;
                  }
                  advance();
                }, entry.afterMs);
                return;
              }

              emitNow();
              continue;
            }

            if (entry.type === 'exit') {
              if (cursor !== entries.length - 1) {
                failScript(`ReplayCliRunner: entries remain after exit at entry ${cursor}`);
                return;
              }
              cursor += 1;
              completeAtExit(entry);
              return;
            }
            failScript(`ReplayCliRunner: invalid script entry at ${cursor}`);
            return;
          }
        } finally {
          advancing = false;
        }
      };

      const controls = {
        writeStdin: (data: string) => {
          if (settled || stdinEnded) return;
          resetIdle();
          stdinRemainder += data;
          const parts = stdinRemainder.split(/\r?\n/);
          stdinRemainder = parts.pop() ?? '';
          let added = false;
          for (const part of parts) {
            if (part.trim().length > 0) {
              outboundQueue.push(part);
              added = true;
            }
          }
          if (added) {
            if (waitingForEmitTimer) {
              failScript(`ReplayCliRunner: unexpected outbound frame before emit_inbound at entry ${cursor}`);
            } else {
              advance();
            }
          }
        },
        endStdin: () => {
          if (settled || stdinEnded) return;
          stdinEnded = true;
          const trailing = stdinRemainder.trim();
          stdinRemainder = '';
          if (trailing.length > 0) {
            outboundQueue.push(trailing);
          }
          advance();
        },
        kill: () => {
          if (settled) return;
          if (pendingExitEntry && outboundQueue.length === 0) {
            const exitEntry = pendingExitEntry;
            finish({
              exitCode: exitEntry.exitCode,
              timedOut: exitEntry.timedOut,
              idleTimedOut: exitEntry.idleTimedOut,
              aborted: exitEntry.aborted,
            });
            return;
          }
          finish({ exitCode: null, aborted: Boolean(options.signal?.aborted) });
        },
      };

      try {
        if (attachSpawnProxy) {
          attachSpawnProxy(controls);
        } else {
          options.onSpawn?.(controls);
        }
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      if (!settled && options.stdinData !== undefined) {
        if (options.stdinData.length > 0) {
          controls.writeStdin(options.stdinData);
        }
        controls.endStdin();
      }

      if (!settled) {
        advance();
      }
    });
  }
}
