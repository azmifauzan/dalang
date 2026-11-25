import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EFFORT_LEVEL_ORDER,
  type EffortLevel,
  type ProviderModelInfo,
  type ProviderStatus,
  type ProviderUsage,
  type UsageWindow,
} from '@dalang/shared';
import { createTurnLogger, redactSecrets } from './logger.js';
import {
  buildProviderAccountEnv,
  detectSandboxEngine,
  wrapWithSandbox,
} from './sandbox.js';
import type {
  AdapterTurnOptions,
  AdapterTurnResult,
  CliAdapter,
  CliRunner,
  RunCommandOptions,
  RunCommandResult,
  TurnTokenUsage,
} from './types.js';

const VALID_EFFORTS = new Set<string>(EFFORT_LEVEL_ORDER);

export function parseClaudeUsageText(text: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^what's contributing/i.test(line) || /^last\s+\d+[hd]/i.test(line)) {
      break;
    }
    const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%\s*(used|remaining|left)?/i);
    if (!pctMatch) continue;
    if (!/current\s+(session|week)|5h|session|week|reset/i.test(line)) continue;
    const pct = Number(pctMatch[1]);
    const isRemaining = /remaining|left/i.test(line);
    const usedPercent = isRemaining ? Math.max(0, Math.min(100, 100 - pct)) : Math.max(0, Math.min(100, pct));
    const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
    const lower = line.toLowerCase();
    const window = lower.includes('week') ? 'weekly' : lower.includes('5') || lower.includes('session') ? '5h' : 'quota';
    const resetMatch = line.match(/reset[s]?\s*(?:in|at)?\s*(.+)$/i);
    const labelPart = line.split('·')[0].trim();
    windows.push({
      group: 'Claude',
      window,
      label: labelPart.slice(0, 64),
      usedPercent,
      remainingPercent,
      resetsAt: resetMatch ? resetMatch[1].trim() : null,
    });
  }
  return windows;
}

// Health-check rule (side-effect-free):
// The stream-json control protocol's `initialize` request runs with `--bare --no-session-persistence`,
// which skips hooks, MCP servers, plugins, and session writes, and makes no API call.
const CLAUDE_INITIALIZE = `${JSON.stringify({ type: 'control_request', request_id: 'dalang-init', request: { subtype: 'initialize' } })}\n`;

interface RawClaudeInitModel {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
  supportsFastMode?: unknown;
  supportsAdaptiveThinking?: unknown;
  supportsThinkingOff?: unknown;
}

function stripContextBracket(raw: string): { base: string; bracket: string | null } {
  const m = raw.match(/^(.+)\[([^\]]+)\]$/);
  return m ? { base: m[1], bracket: m[2] } : { base: raw, bracket: null };
}

function variantLabel(bracket: string): string {
  if (/^1m$/i.test(bracket)) return '1M context';
  return `${bracket.toUpperCase()} context`;
}

/**
 * Parse rich model metadata from Claude Code's `initialize` control response.
 * Variants such as `claude-fable-5-2[1m]` attach to their base model in `variants` rather than duplicating it.
 */
export function parseClaudeInitializeModels(stdout: string): ProviderModelInfo[] {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('control_response')) continue;
    try {
      const ev = JSON.parse(line) as { response?: { response?: { models?: unknown } } };
      const rawModels = ev.response?.response?.models;
      if (!Array.isArray(rawModels)) continue;

      const byBase = new Map<string, ProviderModelInfo>();
      const order: string[] = [];

      for (const item of rawModels as RawClaudeInitModel[]) {
        if (typeof item?.value !== 'string' || !item.value || item.value === 'default') continue;
        const rawValue = item.value.trim();
        const rawResolved =
          typeof item.resolvedModel === 'string' && item.resolvedModel.trim()
            ? item.resolvedModel.trim()
            : rawValue;

        const valParts = stripContextBracket(rawValue);
        const resParts = stripContextBracket(rawResolved);
        const baseKey = resParts.base;
        const bracket = valParts.bracket ?? resParts.bracket;

        const supportedEffortLevels: EffortLevel[] = Array.isArray(item.supportedEffortLevels)
          ? (item.supportedEffortLevels.filter(
              (lvl): lvl is EffortLevel => typeof lvl === 'string' && VALID_EFFORTS.has(lvl),
            ) as EffortLevel[])
          : item.supportsEffort
            ? ['low', 'medium', 'high']
            : [];

        const defaultEffort: EffortLevel | null = supportedEffortLevels.includes('high')
          ? 'high'
          : supportedEffortLevels.includes('medium')
            ? 'medium'
            : (supportedEffortLevels[0] ?? null);

        const displayName =
          typeof item.displayName === 'string' && item.displayName.trim()
            ? item.displayName.trim()
            : baseKey;
        const description = typeof item.description === 'string' ? item.description.trim() : '';
        const supportsFastMode = Boolean(item.supportsFastMode);
        const supportsThinking = Boolean(
          item.supportsAdaptiveThinking || item.supportsThinkingOff === false,
        );

        const existing = byBase.get(baseKey);
        if (existing) {
          if (bracket && !existing.variants.some((v) => v.value === rawValue)) {
            existing.variants.push({
              id: bracket.toLowerCase(),
              label: variantLabel(bracket),
              value: rawValue,
            });
          } else if (!bracket) {
            existing.value = rawValue;
          }
          continue;
        }

        const entry: ProviderModelInfo = {
          id: baseKey,
          value: bracket ? baseKey : rawValue,
          resolvedModel: baseKey,
          displayName,
          description,
          supportedEffortLevels,
          defaultEffort,
          supportsFastMode,
          supportsThinking,
          variants: bracket
            ? [
                {
                  id: bracket.toLowerCase(),
                  label: variantLabel(bracket),
                  value: rawValue,
                },
              ]
            : [],
        };
        byBase.set(baseKey, entry);
        order.push(baseKey);
      }

      return order.map((k) => byBase.get(k)!);
    } catch {
      // Not JSON, keep reading.
    }
  }
  return [];
}

export function extractClaudeUsage(ev: Record<string, unknown>, fallbackModel?: string | null): TurnTokenUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | null =
    typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd)
      ? ev.total_cost_usd
      : null;
  let model = fallbackModel ?? null;

  if (ev.usage && typeof ev.usage === 'object') {
    const u = ev.usage as Record<string, unknown>;
    if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
    if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') cacheWriteTokens = u.cache_creation_input_tokens;
  }

  if (ev.modelUsage && typeof ev.modelUsage === 'object') {
    const entries = Object.entries(ev.modelUsage as Record<string, Record<string, unknown>>);
    if (entries.length > 0) {
      let sumIn = 0;
      let sumOut = 0;
      let sumRead = 0;
      let sumWrite = 0;
      let sumCost = 0;
      let hasCost = false;
      for (const [mName, mStats] of entries) {
        if (!model) model = mName;
        if (typeof mStats?.inputTokens === 'number') sumIn += mStats.inputTokens;
        if (typeof mStats?.outputTokens === 'number') sumOut += mStats.outputTokens;
        if (typeof mStats?.cacheReadInputTokens === 'number') sumRead += mStats.cacheReadInputTokens;
        if (typeof mStats?.cacheCreationInputTokens === 'number') sumWrite += mStats.cacheCreationInputTokens;
        if (typeof mStats?.costUSD === 'number') {
          sumCost += mStats.costUSD;
          hasCost = true;
        }
      }
      if (inputTokens === 0 && sumIn > 0) inputTokens = sumIn;
      if (outputTokens === 0 && sumOut > 0) outputTokens = sumOut;
      if (cacheReadTokens === 0 && sumRead > 0) cacheReadTokens = sumRead;
      if (cacheWriteTokens === 0 && sumWrite > 0) cacheWriteTokens = sumWrite;
      if (costUsd === null && hasCost) costUsd = sumCost;
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && costUsd === null) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    model,
  };
}

export class ClaudeCodeAdapter implements CliAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly binary = 'claude';

  constructor(private readonly runner: CliRunner) {}

  /**
   * Side-effect-free model discovery: `--bare --no-session-persistence` skips user/project hooks,
   * MCP servers, plugins, and session persistence, and `initialize` makes no model API call.
   */
  private async discoverModels(binaryPath: string, configDir?: string | null): Promise<ProviderModelInfo[]> {
    const env = buildProviderAccountEnv(this.id, configDir);
    const reply = await this.runner
      .run(
        binaryPath,
        ['-p', '--bare', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { cwd: os.tmpdir(), timeoutMs: 15_000, stdinData: CLAUDE_INITIALIZE, env },
      )
      .catch(() => null);
    return reply ? parseClaudeInitializeModels(reply.stdout) : [];
  }

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
    const [verRes, authRes] = await Promise.all([
      this.runner.run(binaryPath, ['--version'], { cwd, timeoutMs: 5000, env }).catch(() => null),
      this.runner.run(binaryPath, ['auth', 'status'], { cwd, timeoutMs: 5000, env }).catch(() => null),
    ]);

    const version = verRes?.stdout.trim() || null;
    let loggedIn = false;
    let authSummary = 'Not authenticated';

    if (authRes && authRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(authRes.stdout) as {
          loggedIn?: boolean;
          authMethod?: string;
          email?: string;
          planTier?: string;
          subscriptionType?: string;
        };
        loggedIn = Boolean(parsed.loggedIn);
        if (loggedIn) {
          const tier = parsed.planTier || parsed.subscriptionType || '';
          const acct = parsed.email || parsed.authMethod || 'authenticated';
          authSummary = tier ? `${acct} (${tier})` : acct;
        }
      } catch {
        loggedIn = /logged\s*in/i.test(authRes.stdout);
        authSummary = authRes.stdout.trim().slice(0, 120);
      }
    }

    const [usage, models] = await Promise.all([
      loggedIn
        ? this.getUsage(configDir)
        : Promise.resolve({ available: false, windows: [], error: 'Not logged in' } as ProviderUsage),
      loggedIn ? this.discoverModels(binaryPath, configDir) : Promise.resolve([] as ProviderModelInfo[]),
    ]);

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
      const res = await this.runner.run(
        binaryPath,
        [
          '-p',
          '/usage',
          '--no-session-persistence',
          '--setting-sources',
          'project',
          '--strict-mcp-config',
        ],
        { cwd: os.tmpdir(), timeoutMs: 12000, idleTimeoutMs: 10000, env },
      );
      const combined = `${res.stdout}\n${res.stderr}`.trim();
      const windows = parseClaudeUsageText(combined);
      if (windows.length === 0) {
        return {
          available: false,
          windows: [],
          rawText: combined.slice(0, 500),
          error: res.timedOut ? 'Timed out reading /usage' : 'No parseable usage data returned',
        };
      }
      return { available: true, windows, rawText: combined.slice(0, 500) };
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
      throw new Error('Claude Code CLI (claude) is not installed');
    }

    const { engine: sandboxEngine } = await detectSandboxEngine(this.runner);
    const sandboxAvailable = sandboxEngine !== 'none';
    const permissionFlag =
      options.permissionMode === 'read-only'
        ? 'plan'
        : options.permissionMode === 'workspace-write'
          ? sandboxAvailable
            ? 'bypassPermissions'
            : 'auto'
          : 'acceptEdits';
    const images = options.images ?? [];
    // A long-lived session needs stream-json input so steering messages can follow the prompt.
    const interactive = Boolean(this.runner.supportsInteractiveStdin);
    const streamInput = interactive || images.length > 0;
    const args: string[] = [
      '-p',
      ...(streamInput ? ['--input-format', 'stream-json'] : [options.prompt]),
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--permission-mode',
      permissionFlag,
    ];
    const stdinData = streamInput ? JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: options.prompt },
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data.toString('base64') },
          })),
        ],
      },
    }) + '\n' : undefined;

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.effort) {
      args.push('--effort', options.effort);
    }
    if (options.onTextDelta) {
      args.push('--include-partial-messages');
    }

    const secrets = options.mcp?.bearerToken ? [options.mcp.bearerToken] : undefined;
    let mcpDir: string | undefined;
    if (options.mcp) {
      mcpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dalang-mcp-'));
      fs.chmodSync(mcpDir, 0o700);
      const mcpConfigPath = path.join(mcpDir, 'mcp.json');
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            dalang: {
              type: 'http',
              url: options.mcp.url,
              headers: {
                Authorization: `Bearer ${options.mcp.bearerToken}`,
              },
            },
          },
        }),
        { mode: 0o600 },
      );
      args.push('--mcp-config', mcpConfigPath);
    }

    const env = buildProviderAccountEnv(this.id, options.configDir);

    const logger = createTurnLogger(options.logFilePath, secrets);
    let sessionId: string | null = options.sessionId ?? null;
    let resolvedModel: string | null = options.model ?? null;
    let resultText = '';
    let structuredOutput: unknown = undefined;
    let rateLimitReason: string | undefined;
    let usage: TurnTokenUsage | undefined;
    const assistantChunks: string[] = [];
    let streamedText = false;
    // Partial-message events stream the answer token by token. They repeat what the full
    // `assistant` event carries, so they go to the live view only, never to the turn log.
    const handleStreamEvent = (line: string): boolean => {
      if (!line.startsWith('{"type":"stream_event"')) return false;
      try {
        const event = (JSON.parse(line) as { event?: Record<string, unknown> }).event ?? {};
        const block = event.content_block as { type?: string } | undefined;
        const delta = event.delta as { type?: string; text?: unknown } | undefined;
        if (event.type === 'content_block_start' && block?.type === 'text' && streamedText) {
          options.onTextDelta?.('\n\n');
        } else if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
          streamedText = true;
          options.onTextDelta?.(delta.text);
        }
      } catch {
        // a malformed partial event only loses live text
      }
      return true;
    };

    try {
      const runOptions: RunCommandOptions = {
        cwd: options.projectPath,
        timeoutMs: options.timeoutMs ?? 600_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 180_000,
        signal: options.signal,
        env,
        stdinData,
        onKeepAlive: options.onKeepAlive,
        onStdoutLine: (line) => {
          const safeLine = redactSecrets(line, secrets);
          if (images.length && /"type"\s*:\s*"user"/.test(line.slice(0, 256)) && /"type"\s*:\s*"image"/.test(line)) return;
          if (handleStreamEvent(safeLine.trimStart())) return;
          logger.write(safeLine);
          options.onLogLine?.(safeLine);
          const trimmed = safeLine.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>;
            if (typeof ev.session_id === 'string' && ev.session_id) {
              sessionId = ev.session_id;
            }
            if (ev.type === 'system' && typeof ev.model === 'string' && ev.model) {
              resolvedModel = ev.model;
            }
            if (ev.type === 'rate_limit_event') {
              const info = (ev.rate_limit_info && typeof ev.rate_limit_info === 'object'
                ? ev.rate_limit_info
                : ev) as Record<string, unknown>;
              const status = typeof info.status === 'string' ? info.status.toLowerCase() : '';
              const util = typeof info.utilization === 'number' ? info.utilization : null;
              if (status === 'rejected' || (!status && util !== null && util >= 1)) {
                const win = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'quota';
                rateLimitReason = `Claude rate_limit_event (${win}: ${status || `${Math.round((util ?? 1) * 100)}%`})`;
              }
            }
            if (ev.type === 'result') {
              if (typeof ev.result === 'string') resultText = ev.result;
              if (ev.is_error === true && /^you(?:['’]ve| have) hit your (?:[\d.]+[- ](?:hour|day) |weekly |usage )?limit\b/i.test(resultText.trim())) {
                rateLimitReason = resultText.trim();
              }
              if (ev.structured_output !== undefined) structuredOutput = ev.structured_output;
              const extracted = extractClaudeUsage(ev, resolvedModel);
              if (extracted) usage = extracted;
            }
            if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
              const msg = ev.message as { model?: string; content?: Array<{ type?: string; text?: string }> };
              if (typeof msg.model === 'string' && msg.model) resolvedModel = msg.model;
              for (const block of msg.content ?? []) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  assistantChunks.push(block.text);
                }
              }
            }
          } catch {
            // ignore non-JSON lines
          }
        },
        onStderrLine: (line) => {
          const safeLine = redactSecrets(line, secrets);
          logger.write(`[stderr] ${safeLine}`);
          options.onLogLine?.(`[stderr] ${safeLine}`);
        },
      };
      const invocation = await wrapWithSandbox(this.runner, this.id, options.projectPath, binaryPath, args,
        { readOnly: options.permissionMode === 'read-only', configDir: options.configDir, mcpDir });
      if (permissionFlag === 'bypassPermissions' && !invocation.sandboxed) {
        throw new Error('The platform sandbox became unavailable before starting Claude.');
      }
      const res = interactive
        ? await this.runSession(invocation.command, invocation.args, stdinData!, options, runOptions)
        : await this.runner.run(invocation.command, invocation.args, runOptions);

      const text = resultText || assistantChunks.join('\n').trim();
      if (!res.aborted && (res.timedOut || res.idleTimedOut)) {
        throw new Error(`Claude turn timed out (${res.idleTimedOut ? 'idle' : 'total'})`);
      }

      return {
        text: redactSecrets(text, secrets),
        sessionId,
        structuredOutput,
        exitCode: res.exitCode,
        stdout: redactSecrets(res.stdout, secrets),
        stderr: redactSecrets(res.stderr, secrets),
        logFilePath: options.logFilePath,
        aborted: Boolean(res.aborted),
        ...(rateLimitReason ? { rateLimitReason } : {}),
        ...(usage ? { usage } : {}),
      };
    } finally {
      if (mcpDir) fs.rmSync(mcpDir, { recursive: true, force: true });
      logger.close();
    }
  }

  /**
   * Keeps the stream-json process open after the prompt so a message can steer the turn and an
   * interrupt control request can stop it without ending the session.
   */
  private async runSession(
    command: string,
    args: string[],
    firstMessage: string,
    options: AdapterTurnOptions,
    runOptions: RunCommandOptions,
  ): Promise<RunCommandResult> {
    let write: ((data: string) => void) | undefined;
    let endInput: (() => void) | undefined;
    let interrupted = false;
    const pendingSteering = new Set<string>();
    const send = (message: unknown) => {
      if (!write) throw new Error('Claude session has stopped accepting messages.');
      write(JSON.stringify(message) + '\n');
    };
    const userMessage = (content: string, extra: object = {}) => ({
      type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...extra,
    });
    const result = await this.runner.run(command, args, {
      ...runOptions,
      stdinData: undefined,
      interactiveStdin: true,
      onSpawn: (controls) => {
        write = controls.writeStdin;
        endInput = controls.endStdin;
        write(firstMessage);
      },
      onStdoutLine: (line) => {
        runOptions.onStdoutLine?.(line);
        if (!line.startsWith('{')) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === 'system' && event.subtype === 'init') {
          options.onControls?.({
            steer: async (text) => {
              const uuid = randomUUID();
              pendingSteering.add(uuid);
              try {
                send(userMessage(text, { uuid, priority: 'now' }));
              } catch (error) {
                pendingSteering.delete(uuid);
                throw error;
              }
              runOptions.onStdoutLine?.(JSON.stringify({ type: 'user.steer', text }));
            },
            interrupt: async () => {
              interrupted = true;
              send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
            },
          });
        } else if (event.type === 'result') {
          // A steering message can end the earlier prompt before its own result arrives.
          const ids = [event.user_message_uuid, ...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [])];
          for (const id of ids) if (typeof id === 'string') pendingSteering.delete(id);
          if (pendingSteering.size === 0 || event.is_error === true || interrupted) endInput?.();
        }
      },
    }).finally(() => options.onControls?.(null));
    return interrupted ? { ...result, aborted: true } : result;
  }
}
