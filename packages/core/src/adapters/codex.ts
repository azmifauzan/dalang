import fs from 'node:fs';
import os from 'node:os';
import {
  EFFORT_LEVEL_ORDER,
  type EffortLevel,
  type ProviderModelInfo,
  type ProviderStatus,
  type ProviderUsage,
  type UsageWindow,
} from '@dalang/shared';
import { createTurnLogger } from './logger.js';
import {
  buildProviderAccountEnv,
  detectSandboxEngine,
  findBwrap,
  wrapWithSandbox,
} from './sandbox.js';
import type {
  AdapterTurnOptions,
  AdapterTurnResult,
  CliAdapter,
  CliRunner,
  TurnTokenUsage,
} from './types.js';

const VALID_EFFORTS = new Set<string>(EFFORT_LEVEL_ORDER);

interface CodexRateLimitBucket {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number | string;
}

export function parseCodexRateLimits(payload: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (!payload || typeof payload !== 'object') return windows;
  const obj = payload as Record<string, unknown>;
  const rateLimits = (obj.rateLimits ?? obj) as Record<string, unknown>;

  const pushBucket = (key: string, bucket: CodexRateLimitBucket | undefined) => {
    if (!bucket || typeof bucket !== 'object') return;
    const used = typeof bucket.usedPercent === 'number' ? bucket.usedPercent : null;
    const mins = typeof bucket.windowDurationMins === 'number' ? bucket.windowDurationMins : null;
    const windowLabel =
      mins === 300 ? '5h' : mins === 10080 ? 'weekly' : mins ? `${mins}m` : key;
    const resetsAt =
      typeof bucket.resetsAt === 'number'
        ? new Date(bucket.resetsAt * 1000).toISOString()
        : typeof bucket.resetsAt === 'string'
          ? bucket.resetsAt
          : null;
    windows.push({
      group: 'Codex',
      window: windowLabel,
      label: `${key} (${windowLabel})`,
      usedPercent: used,
      remainingPercent: used !== null ? Math.max(0, Math.min(100, 100 - used)) : null,
      resetsAt,
    });
  };

  pushBucket('primary', rateLimits.primary as CodexRateLimitBucket | undefined);
  pushBucket('secondary', rateLimits.secondary as CodexRateLimitBucket | undefined);
  return windows;
}

interface RawCodexModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string; description?: string } | string>;
}

/**
 * Parse rich model objects from `codex debug models`.
 */
export function parseCodexModelsJson(stdout: string): ProviderModelInfo[] {
  try {
    const parsed = JSON.parse(stdout) as { models?: RawCodexModel[] };
    const out: ProviderModelInfo[] = [];
    for (const m of parsed.models ?? []) {
      if (typeof m.slug !== 'string' || !m.slug.trim()) continue;
      if ((m.visibility ?? 'list') !== 'list') continue;
      const slug = m.slug.trim();
      const rawLevels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((entry) =>
            typeof entry === 'string' ? entry : typeof entry?.effort === 'string' ? entry.effort : '',
          )
        : [];
      const supportedEffortLevels = EFFORT_LEVEL_ORDER.filter((lvl) => rawLevels.includes(lvl));
      const rawDefault = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level.trim() : '';
      const defaultEffort: EffortLevel | null =
        VALID_EFFORTS.has(rawDefault) && supportedEffortLevels.includes(rawDefault as EffortLevel)
          ? (rawDefault as EffortLevel)
          : (supportedEffortLevels[0] ?? null);

      out.push({
        id: slug,
        value: slug,
        resolvedModel: slug,
        displayName:
          typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : slug,
        description: typeof m.description === 'string' ? m.description.trim() : '',
        supportedEffortLevels,
        defaultEffort,
        supportsFastMode: false,
        supportsThinking: supportedEffortLevels.length > 0,
        variants: [],
      });
    }
    return out;
  } catch {
    return [];
  }
}

function accumulateCodexUsage(
  acc: TurnTokenUsage,
  usageObj: Record<string, unknown>,
  model?: string | null,
): TurnTokenUsage {
  const input = typeof usageObj.input_tokens === 'number' ? usageObj.input_tokens : 0;
  const cached = typeof usageObj.cached_input_tokens === 'number' ? usageObj.cached_input_tokens : 0;
  const cacheWrite =
    typeof usageObj.cache_write_input_tokens === 'number' ? usageObj.cache_write_input_tokens : 0;
  const output = typeof usageObj.output_tokens === 'number' ? usageObj.output_tokens : 0;
  // Codex reports `input_tokens` inclusive of `cached_input_tokens` in turn.completed.
  const uncachedInput = Math.max(0, input - cached);
  return {
    inputTokens: acc.inputTokens + uncachedInput,
    outputTokens: acc.outputTokens + output,
    cacheReadTokens: acc.cacheReadTokens + cached,
    cacheWriteTokens: acc.cacheWriteTokens + cacheWrite,
    costUsd: acc.costUsd,
    model: model ?? acc.model,
  };
}

export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly binary = 'codex';

  constructor(private readonly runner: CliRunner) {}

  /**
   * Side-effect-free health checks: `--version`, `login status`, `debug models`, and read-only
   * `app-server` JSON-RPC `account/rateLimits/read` run from `os.tmpdir()` and never invoke hooks or turns.
   */
  async checkStatus(configDir?: string | null): Promise<ProviderStatus> {
    const checkedAt = new Date().toISOString();
    const binaryPath = await this.runner.which(this.binary);
    const { engine: sandboxEngine } = await detectSandboxEngine(this.runner);
    const sandboxReady = sandboxEngine !== 'none';

    if (!binaryPath) {
      return {
        id: this.id,
        displayName: this.displayName,
        binary: this.binary,
        binaryPath: null,
        installed: false,
        version: null,
        loggedIn: false,
        authSummary: 'Binary not found in PATH',
        sandboxReady,
        sandboxEngine,
        models: [],
        usage: { available: false, windows: [], error: 'Not installed' },
        checkedAt,
      };
    }

    const cwd = os.tmpdir();
    const env = buildProviderAccountEnv(this.id, configDir);
    const [verRes, authRes, modelsRes] = await Promise.all([
      this.runner.run(binaryPath, ['--version'], { cwd, timeoutMs: 5000, env }).catch(() => null),
      this.runner.run(binaryPath, ['login', 'status'], { cwd, timeoutMs: 5000, env }).catch(() => null),
      this.runner.run(binaryPath, ['debug', 'models'], { cwd, timeoutMs: 10000, env }).catch(() => null),
    ]);
    const models = modelsRes ? parseCodexModelsJson(modelsRes.stdout) : [];

    const version = verRes?.stdout.trim() || null;
    const authOut = `${authRes?.stdout ?? ''}\n${authRes?.stderr ?? ''}`.trim();
    const loggedIn = /logged\s*in/i.test(authOut) && !/not\s*logged\s*in/i.test(authOut);
    const authSummary = authOut ? authOut.split(/\r?\n/)[0].trim() : 'Unknown login status';

    const usage = loggedIn
      ? await this.getUsage(configDir)
      : { available: false, windows: [], error: 'Not logged in' };

    return {
      id: this.id,
      displayName: this.displayName,
      binary: this.binary,
      binaryPath,
      installed: true,
      version,
      loggedIn,
      authSummary,
      sandboxReady,
      sandboxEngine,
      models,
      usage,
      checkedAt,
    };
  }

  async getUsage(configDir?: string | null): Promise<ProviderUsage> {
    const binaryPath = await this.runner.which(this.binary);
    if (!binaryPath) {
      return { available: false, windows: [], error: 'Binary not installed' };
    }

    const env = buildProviderAccountEnv(this.id, configDir);
    try {
      let controls: {
        writeStdin: (data: string) => void;
        endStdin: () => void;
        kill: () => void;
      } | null = null;
      let rateLimitsSent = false;
      let parsedWindows: UsageWindow[] = [];

      const res = await this.runner.run(binaryPath, ['app-server'], {
        cwd: os.tmpdir(),
        interactiveStdin: true,
        timeoutMs: 8000,
        idleTimeoutMs: 5000,
        env,
        onSpawn: (c) => {
          controls = c;
          c.writeStdin(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { clientInfo: { name: 'dalang', version: '0.5.0' } },
            }) +
              '\n' +
              JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) +
              '\n',
          );
        },
        onStdoutLine: (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const msg = JSON.parse(trimmed) as { id?: number; method?: string; result?: unknown };
            if (!rateLimitsSent && (msg.id === 1 || msg.method === 'account/updated')) {
              rateLimitsSent = true;
              controls?.writeStdin(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'account/rateLimits/read',
                  params: {},
                }) + '\n',
              );
            }
            if (msg.id === 2 && msg.result) {
              parsedWindows = parseCodexRateLimits(msg.result);
              controls?.endStdin();
              controls?.kill();
            }
          } catch {
            // ignore
          }
        },
      });

      if (parsedWindows.length > 0) {
        return { available: true, windows: parsedWindows };
      }

      const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown };
          if (msg.id === 2 && msg.result) {
            const windows = parseCodexRateLimits(msg.result);
            if (windows.length > 0) {
              return { available: true, windows };
            }
          }
        } catch {
          // ignore
        }
      }
      return {
        available: false,
        windows: [],
        rawText: res.stdout.slice(0, 400),
        error: 'Rate limits not returned by codex app-server',
      };
    } catch (err) {
      return {
        available: false,
        windows: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async runTurn(options: AdapterTurnOptions): Promise<AdapterTurnResult> {
    const binaryPath = await this.runner.which(this.binary);
    if (!binaryPath) {
      throw new Error('Codex CLI (codex) is not installed');
    }

    // `exec resume` has no --sandbox flag, so the mode goes through -c for both paths.
    const args: string[] = options.sessionId
      ? ['exec', 'resume', options.sessionId, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check'];

    // Codex's own sandbox cannot nest inside bwrap ("No permissions to create a new namespace"),
    // so when bwrap is the boundary Codex runs unsandboxed inside it (with bwrap enforcing ro/rw).
    const bwrapAvailable = Boolean(await findBwrap(this.runner));
    const isReadOnly = options.permissionMode === 'read-only';
    const sandboxMode = bwrapAvailable
      ? 'danger-full-access'
      : isReadOnly
        ? 'read-only'
        : 'workspace-write';
    args.push('-c', `sandbox_mode="${sandboxMode}"`, '-c', 'approval_policy="never"');
    if (options.model) {
      args.push('-m', options.model);
    }
    if (options.effort) {
      args.push('-c', `model_reasoning_effort="${options.effort}"`);
    }
    if (options.outputFilePath && !isReadOnly) {
      args.push('-o', options.outputFilePath);
    }
    args.push(options.prompt);

    const invocation = await wrapWithSandbox(
      this.runner,
      this.id,
      options.projectPath,
      binaryPath,
      args,
      { readOnly: isReadOnly, configDir: options.configDir },
    );
    const env = buildProviderAccountEnv(this.id, options.configDir);

    const logger = createTurnLogger(options.logFilePath);
    let sessionId: string | null = options.sessionId ?? null;
    const messages: string[] = [];
    let usageAcc: TurnTokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      model: options.model ?? null,
    };
    let sawUsage = false;

    try {
      const res = await this.runner.run(invocation.command, invocation.args, {
        cwd: options.projectPath,
        timeoutMs: options.timeoutMs ?? 600_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 180_000,
        signal: options.signal,
        env,
        onStdoutLine: (line) => {
          logger.write(line);
          options.onLogLine?.(line);
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>;
            if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
              sessionId = ev.thread_id;
            }
            if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
              const item = ev.item as { type?: string; text?: string };
              if (item.type === 'agent_message' && typeof item.text === 'string') {
                messages.push(item.text);
              }
            }
            if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
              usageAcc = accumulateCodexUsage(usageAcc, ev.usage as Record<string, unknown>, options.model);
              sawUsage = true;
            }
            if (ev.type === 'token_usage_record' && ev.payload && typeof ev.payload === 'object') {
              const payload = ev.payload as { usage?: Record<string, unknown> };
              if (payload.usage && typeof payload.usage === 'object') {
                usageAcc = accumulateCodexUsage(usageAcc, payload.usage, options.model);
                sawUsage = true;
              }
            }
          } catch {
            // ignore non-JSON
          }
        },
        onStderrLine: (line) => {
          logger.write(`[stderr] ${line}`);
          options.onLogLine?.(`[stderr] ${line}`);
        },
      });

      if (!res.aborted && (res.timedOut || res.idleTimedOut)) {
        throw new Error(`Codex turn timed out (${res.idleTimedOut ? 'idle' : 'total'})`);
      }

      let finalMessage = messages.join('\n').trim();
      if (!finalMessage && options.outputFilePath && fs.existsSync(options.outputFilePath)) {
        finalMessage = fs.readFileSync(options.outputFilePath, 'utf8').trim();
      }

      let structuredOutput: unknown = undefined;
      if (finalMessage.startsWith('{')) {
        try {
          structuredOutput = JSON.parse(finalMessage);
        } catch {
          // ignore
        }
      }

      return {
        text: finalMessage,
        sessionId,
        structuredOutput,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        logFilePath: options.logFilePath,
        aborted: Boolean(res.aborted),
        ...(sawUsage ? { usage: usageAcc } : {}),
      };
    } finally {
      logger.close();
    }
  }
}
