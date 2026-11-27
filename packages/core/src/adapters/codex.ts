import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DALANG_VERSION,
  EFFORT_LEVEL_ORDER,
  type EffortLevel,
  type ProviderModelInfo,
  type ProviderStatus,
  type ProviderUsage,
  type UsageWindow,
} from '@dalang/shared';
import { createTurnLogger, redactSecrets } from './logger.js';
import { FatalStderrError, object, SessionRpcError, turnRunner, withSessionRpc } from './session-rpc.js';
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

export function accumulateCodexUsage(
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
              params: { clientInfo: { name: 'dalang', version: DALANG_VERSION } },
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

    if (this.runner.supportsInteractiveStdin && !options.outputFilePath) {
      const turn = await this.runSessionTurn(binaryPath, options);
      if (turn) return turn;
    }

    // `exec resume` has no --sandbox flag, so the mode goes through -c for both paths.
    const args: string[] = options.sessionId
      ? ['exec', 'resume', options.sessionId, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check'];

    // Bubblewrap and MXC enforce the workspace boundary outside Codex.
    const { engine } = await detectSandboxEngine(this.runner);
    const isReadOnly = options.permissionMode === 'read-only';
    const sandboxMode = engine === 'bwrap' || engine === 'windows-mxc'
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
    const secrets = options.mcp?.bearerToken ? [options.mcp.bearerToken] : undefined;
    if (options.mcp) {
      args.push(
        '-c',
        `mcp_servers.dalang.url="${options.mcp.url}"`,
        '-c',
        'mcp_servers.dalang.bearer_token_env_var="DALANG_MCP_TOKEN"',
        '-c',
        'mcp_servers.dalang.enabled=true',
      );
    }
    const env: Record<string, string | undefined> = {
      ...buildProviderAccountEnv(this.id, options.configDir),
      ...(options.mcp ? { DALANG_MCP_TOKEN: options.mcp.bearerToken } : {}),
    };

    const logger = createTurnLogger(options.logFilePath, secrets);
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
    let imageDir: string | undefined;

    try {
      if (options.images?.length) {
        imageDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dalang-images-'));
        for (const [index, image] of options.images.entries()) {
          const imagePath = path.join(imageDir, `${index}.${image.mimeType.split('/')[1]}`);
          fs.writeFileSync(imagePath, image.data, { mode: 0o600 });
          args.push('--image', imagePath);
        }
        args.push('--');
      }
      args.push(options.prompt);
      const invocation = await wrapWithSandbox(
        this.runner, this.id, options.projectPath, binaryPath, args,
        { readOnly: isReadOnly, configDir: options.configDir, imageDir },
      );
      if (sandboxMode === 'danger-full-access' && !invocation.sandboxed) {
        throw new Error('The platform sandbox became unavailable before starting Codex.');
      }
      const res = await turnRunner(this.runner, 'codex', secrets, invocation.engine).run(invocation.command, invocation.args, {
        cwd: options.projectPath,
        timeoutMs: options.timeoutMs ?? 600_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 180_000,
        signal: options.signal,
        env,
        onKeepAlive: options.onKeepAlive,
        onStdoutLine: (line) => {
          const safeLine = redactSecrets(line, secrets);
          logger.write(safeLine);
          options.onLogLine?.(safeLine);
          const trimmed = safeLine.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>;
            if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
              sessionId = ev.thread_id;
            }
            if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
              const item = ev.item as { type?: string; text?: string };
              if (item.type === 'agent_message' && typeof item.text === 'string') {
                // `codex exec` has no token deltas, so each finished message is shown whole.
                options.onTextDelta?.(messages.length ? `\n\n${item.text}` : item.text);
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
          const safeLine = redactSecrets(line, secrets);
          logger.write(`[stderr] ${safeLine}`);
          options.onLogLine?.(`[stderr] ${safeLine}`);
        },
      });

      if (!res.aborted && (res.timedOut || res.idleTimedOut)) {
        throw new Error(`Codex turn timed out (${res.idleTimedOut ? 'idle' : 'total'})`);
      }

      let finalMessage = messages.join('\n').trim();
      if (!finalMessage && options.outputFilePath && fs.existsSync(options.outputFilePath)) {
        finalMessage = fs.readFileSync(options.outputFilePath, 'utf8').trim();
      }
      finalMessage = redactSecrets(finalMessage, secrets);

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
        stdout: redactSecrets(res.stdout, secrets),
        stderr: redactSecrets(res.stderr, secrets),
        logFilePath: options.logFilePath,
        aborted: Boolean(res.aborted),
        ...(sawUsage ? { usage: usageAcc } : {}),
      };
    } finally {
      if (imageDir) fs.rmSync(imageDir, { recursive: true, force: true });
      await logger.close();
    }
  }

  private async runSessionTurn(binary: string, options: AdapterTurnOptions): Promise<AdapterTurnResult | null> {
    const readOnly = options.permissionMode === 'read-only';
    const secrets = [options.mcp?.bearerToken];
    const args = ['app-server'];
    if (options.mcp) {
      args.push(
        '-c', `mcp_servers.dalang.url=${JSON.stringify(options.mcp.url)}`,
        '-c', 'mcp_servers.dalang.bearer_token_env_var="DALANG_MCP_TOKEN"',
        '-c', 'mcp_servers.dalang.enabled=true',
      );
    }
    const invocation = await wrapWithSandbox(this.runner, this.id, options.projectPath, binary, args,
      { readOnly, configDir: options.configDir });
    const logger = createTurnLogger(options.logFilePath, secrets);
    const log = (event: unknown) => {
      const line = redactSecrets(JSON.stringify(event), secrets);
      logger.write(line);
      options.onLogLine?.(line);
    };
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let sessionId = options.sessionId ?? null;
    let turnId: string | undefined;
    let submitted = false;
    let complete!: (turn: Record<string, unknown>) => void;
    const completion = new Promise<Record<string, unknown>>((resolve) => { complete = resolve; });
    const messages: string[] = [];
    let streamItemId: string | null = null;
    let usage: TurnTokenUsage | undefined;
    let lastProviderError = '';
    let rateLimitReason: string | undefined;
    let stderr = '';
    try {
      const turn = await withSessionRpc(turnRunner(this.runner, 'codex', secrets, invocation.engine), invocation.command, invocation.args, {
        cwd: options.projectPath,
        env: { ...buildProviderAccountEnv(this.id, options.configDir), DALANG_MCP_TOKEN: options.mcp?.bearerToken },
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        signal,
        onKeepAlive: options.onKeepAlive,
        onStderrLine: (line) => {
          const safe = redactSecrets(line, secrets);
          stderr = (stderr + safe + '\n').slice(-8000);
          logger.write(`[stderr] ${safe}`);
          options.onLogLine?.(`[stderr] ${safe}`);
        },
      }, (method, params) => {
        if (params.threadId !== sessionId) return;
        if (method === 'error' && (!turnId || params.turnId === turnId)) {
          const error = object(params.error);
          lastProviderError = [error.message, error.additionalDetails]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join(' ');
          log({ type: 'provider.error', message: lastProviderError, retrying: params.willRetry === true });
          const info = error.codexErrorInfo;
          if (readOnly && submitted && (info === 'usageLimitExceeded' || object(object(info).responseStreamDisconnected).httpStatusCode === 429)) {
            rateLimitReason = info === 'usageLimitExceeded' ? 'Codex usage limit exceeded.' : 'Codex rate limited the request (HTTP 429).';
            complete({ status: 'failed', error: { message: rateLimitReason } });
          }
        }
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          // A new message item after earlier text starts a new paragraph.
          if (params.itemId !== streamItemId) {
            if (streamItemId !== null) options.onTextDelta?.('\n\n');
            streamItemId = typeof params.itemId === 'string' ? params.itemId : null;
          }
          options.onTextDelta?.(params.delta);
          return;
        }
        if (method === 'turn/completed') {
          const finished = object(params.turn);
          if (!turnId || finished.id === turnId) complete(finished);
        }
        if (method === 'item/completed' || method === 'item/started') {
          const item = object(params.item);
          if (item.type === 'userMessage') return;
          if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
            messages.push(redactSecrets(item.text, secrets));
          }
          const type = typeof item.type === 'string' ? item.type.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()) : item.type;
          log({ type: method.replace('/', '.'), item: { ...item, type, aggregated_output: item.aggregatedOutput } });
        }
        if (method === 'thread/tokenUsage/updated') {
          const last = object(object(params.tokenUsage).last);
          const count = (key: string) => typeof last[key] === 'number' ? last[key] as number : 0;
          if (Object.keys(last).length) {
            usage = {
              inputTokens: count('inputTokens'), outputTokens: count('outputTokens'),
              cacheReadTokens: count('cachedInputTokens'), cacheWriteTokens: count('cacheWriteInputTokens'),
              model: options.model, costUsd: null,
            };
          }
        }
      }, async (rpc) => {
        await rpc.request('initialize', { clientInfo: { name: 'dalang', version: DALANG_VERSION } });
        rpc.notify('initialized', {});
        const thread = await rpc.request(sessionId ? 'thread/resume' : 'thread/start', {
          ...(sessionId ? { threadId: sessionId, excludeTurns: true } : {}),
          cwd: options.projectPath,
          model: options.model ?? null,
          approvalPolicy: 'never',
          sandbox: invocation.engine === 'bwrap' || invocation.engine === 'windows-mxc'
            ? 'danger-full-access' : readOnly ? 'read-only' : 'workspace-write',
        });
        const id = object(thread.thread).id;
        if (typeof id !== 'string') throw new Error('Codex did not return a thread ID.');
        sessionId = id;
        const textInput = (text: string) => ({ type: 'text', text, text_elements: [] });
        submitted = true;
        const started = await rpc.request('turn/start', {
          threadId: id,
          effort: options.effort,
          input: [
            textInput(options.prompt),
            ...(options.images ?? []).map((image) => ({
              type: 'image', url: `data:${image.mimeType};base64,${image.data.toString('base64')}`,
            })),
          ],
        });
        const activeId = object(started.turn).id;
        if (typeof activeId !== 'string') throw new Error('Codex did not return a turn ID.');
        turnId = activeId;
        options.onControls?.({
          steer: async (text) => {
            await rpc.request('turn/steer', { threadId: id, expectedTurnId: activeId, input: [textInput(text)] });
            log({ type: 'user.steer', text });
          },
          interrupt: async () => {
            await rpc.request('turn/interrupt', { threadId: id, turnId: activeId });
          },
        });
        return completion;
      });
      const aborted = turn.status === 'interrupted';
      const text = messages.join('\n').trim();
      let structuredOutput: unknown;
      try { structuredOutput = JSON.parse(text); } catch { /* A text response is valid. */ }
      const error = object(turn.error).message;
      return {
        text, sessionId, structuredOutput, aborted, usage, logFilePath: options.logFilePath, stdout: '',
        stderr: redactSecrets([typeof error === 'string' ? error : '', stderr].filter(Boolean).join('\n').slice(-4000), secrets),
        exitCode: turn.status === 'completed' || aborted ? 0 : 1,
        ...(rateLimitReason ? { rateLimitReason } : {}),
      };
    } catch (error) {
      if (options.signal?.aborted) return { text: '', sessionId, aborted: true, exitCode: null, stdout: '', stderr };
      if (error instanceof FatalStderrError) throw error;
      if (!submitted || error instanceof SessionRpcError && error.code === -32601) return null;
      const detail = lastProviderError ? `${String(error)} ${lastProviderError}` : String(error);
      return { text: messages.join('\n'), sessionId, exitCode: 1, stdout: '', stderr: redactSecrets(detail, secrets), usage };
    } finally {
      options.onControls?.(null);
      controller.abort();
      await logger.close();
    }
  }
}
