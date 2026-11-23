import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EFFORT_LEVEL_ORDER,
  splitEffortModel,
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
  findBwrap,
  startDbusProxy,
  wrapWithSandbox,
} from './sandbox.js';
import type {
  AdapterTurnOptions,
  AdapterTurnResult,
  CliAdapter,
  CliRunner,
  TurnTokenUsage,
} from './types.js';

interface AgyUsageJson {
  status?: string;
  command?: {
    name?: string;
    data?: {
      groups?: Array<{
        name?: string;
        buckets?: Array<{
          id?: string;
          name?: string;
          window?: string;
          remaining_fraction?: number;
          reset_time?: string;
        }>;
      }>;
    };
  };
}

/**
 * Parse `agy models` output (`<id>\t<Display Name>`) into structured model objects.
 * Effort levels remain encoded in the CLI id (`gemini-4-neon-high`); this groups them by base model
 * and preserves the display name from `agy models`.
 */
export function parseAgyModelsOutput(stdout: string): ProviderModelInfo[] {
  const byBase = new Map<
    string,
    { base: string; displayName: string; levels: Set<EffortLevel>; rawId: string }
  >();
  const order: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Fetching')) continue;
    const tabIdx = trimmed.indexOf('\t');
    const id = (tabIdx >= 0 ? trimmed.slice(0, tabIdx) : trimmed.split(/\s+/)[0]).trim();
    const rawLabel = tabIdx >= 0 ? trimmed.slice(tabIdx + 1).trim() : '';
    if (!id || !/^[a-z0-9][a-z0-9._-]+$/i.test(id)) continue;

    const split = splitEffortModel(id);
    if (split) {
      const cleanLabel = rawLabel.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, '').trim() || split.base;
      const existing = byBase.get(split.base);
      if (existing) {
        existing.levels.add(split.level);
        if (existing.displayName === existing.base && cleanLabel !== split.base) {
          existing.displayName = cleanLabel;
        }
      } else {
        byBase.set(split.base, {
          base: split.base,
          displayName: cleanLabel,
          levels: new Set<EffortLevel>([split.level]),
          rawId: id,
        });
        order.push(split.base);
      }
    } else if (!byBase.has(id)) {
      byBase.set(id, {
        base: id,
        displayName: rawLabel || id,
        levels: new Set<EffortLevel>(),
        rawId: id,
      });
      order.push(id);
    }
  }

  return order.map((key) => {
    const entry = byBase.get(key)!;
    const supportedEffortLevels = EFFORT_LEVEL_ORDER.filter((lvl) => entry.levels.has(lvl));
    const defaultEffort: EffortLevel | null = supportedEffortLevels.includes('high')
      ? 'high'
      : supportedEffortLevels.includes('medium')
        ? 'medium'
        : (supportedEffortLevels[0] ?? null);
    return {
      id: entry.base,
      value: entry.base,
      resolvedModel: entry.base,
      displayName: entry.displayName,
      description: '',
      supportedEffortLevels,
      defaultEffort,
      supportsFastMode: false,
      supportsThinking: supportedEffortLevels.length > 0,
      variants: [],
    };
  });
}

export function parseAgyUsageJson(raw: string): { ok: boolean; windows: UsageWindow[] } {
  try {
    const parsed = JSON.parse(raw) as AgyUsageJson;
    const groups = parsed.command?.data?.groups ?? [];
    const windows: UsageWindow[] = [];
    for (const group of groups) {
      for (const bucket of group.buckets ?? []) {
        const remainingFrac =
          typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : null;
        const remainingPercent =
          remainingFrac !== null ? Math.round(remainingFrac * 100) : null;
        const usedPercent =
          remainingPercent !== null ? Math.max(0, Math.min(100, 100 - remainingPercent)) : null;
        windows.push({
          group: group.name ?? 'Antigravity',
          window: bucket.window ?? 'quota',
          label: `${group.name ?? 'Antigravity'} · ${bucket.name ?? bucket.window ?? 'quota'}`,
          usedPercent,
          remainingPercent,
          resetsAt: bucket.reset_time ?? null,
        });
      }
    }
    return { ok: parsed.status === 'SUCCESS', windows };
  } catch {
    return { ok: false, windows: [] };
  }
}

export function extractAgyUsage(ev: Record<string, unknown>, fallbackModel?: string | null): TurnTokenUsage | undefined {
  const containers: Array<Record<string, unknown>> = [];
  if (ev.usage && typeof ev.usage === 'object') containers.push(ev.usage as Record<string, unknown>);
  if (ev.stats && typeof ev.stats === 'object') containers.push(ev.stats as Record<string, unknown>);
  if (ev.result && typeof ev.result === 'object') {
    const inner = ev.result as Record<string, unknown>;
    if (inner.usage && typeof inner.usage === 'object') containers.push(inner.usage as Record<string, unknown>);
    if (inner.stats && typeof inner.stats === 'object') containers.push(inner.stats as Record<string, unknown>);
  }

  for (const u of containers) {
    const input =
      (typeof u.input_tokens === 'number' ? u.input_tokens : undefined) ??
      (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined) ??
      (typeof u.inputTokens === 'number' ? u.inputTokens : 0);
    const output =
      (typeof u.output_tokens === 'number' ? u.output_tokens : undefined) ??
      (typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined) ??
      (typeof u.outputTokens === 'number' ? u.outputTokens : 0);
    const cacheRead =
      (typeof u.cache_read_tokens === 'number' ? u.cache_read_tokens : undefined) ??
      (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined) ??
      (typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined) ??
      (typeof u.cached_tokens === 'number' ? u.cached_tokens : undefined) ??
      (typeof u.cacheReadInputTokens === 'number' ? u.cacheReadInputTokens : 0);
    const cacheWrite =
      (typeof u.cache_write_tokens === 'number' ? u.cache_write_tokens : undefined) ??
      (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined) ??
      (typeof u.cacheWriteInputTokens === 'number' ? u.cacheWriteInputTokens : 0);
    const costUsd =
      typeof u.total_cost_usd === 'number'
        ? u.total_cost_usd
        : typeof u.cost_usd === 'number'
          ? u.cost_usd
          : null;

    if (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || costUsd !== null) {
      return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd,
        model: fallbackModel ?? null,
      };
    }
  }
  return undefined;
}

export const KEYRING_OFF_MESSAGE =
  'Antigravity signs in through the desktop keyring, so a sandboxed run can read every secret stored there. It is off by default: enable "Allow Antigravity to read the desktop keyring" on the Providers page to use it.';

export class AntigravityAdapter implements CliAdapter {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity CLI';
  readonly binary = 'agy';

  constructor(
    private readonly runner: CliRunner,
    private readonly policy: { antigravityKeyringAccess: () => boolean } = {
      antigravityKeyringAccess: () => false,
    },
  ) {}

  /**
   * Side-effect-free health checks: `--version`, `models`, and `-p=/usage --output-format json`
   * run from `os.tmpdir()` without mutating any workspace or triggering project hooks.
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
    const [verRes, modelsRes, usage] = await Promise.all([
      this.runner.run(binaryPath, ['--version'], { cwd, timeoutMs: 5000, env }).catch(() => null),
      this.runner.run(binaryPath, ['models'], { cwd, timeoutMs: 10000, env }).catch(() => null),
      this.getUsage(configDir),
    ]);

    const version = verRes?.stdout.trim() || null;
    const models = modelsRes ? parseAgyModelsOutput(modelsRes.stdout) : [];
    const loggedIn = usage.available || models.length > 0;
    const authSummary = usage.available
      ? 'Authenticated (usage quota readable)'
      : models.length > 0
        ? 'Authenticated (models reachable)'
        : usage.error || 'Not authenticated';

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
        ['-p=/usage', '--output-format', 'json'],
        { cwd: os.tmpdir(), timeoutMs: 10000, idleTimeoutMs: 8000, env },
      );
      const parsed = parseAgyUsageJson(res.stdout);
      if (parsed.ok && parsed.windows.length > 0) {
        return { available: true, windows: parsed.windows };
      }
      return {
        available: false,
        windows: [],
        rawText: res.stdout.slice(0, 400),
        error: res.stderr.trim() || 'Unable to read agy usage',
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
      throw new Error('Antigravity CLI (agy) is not installed');
    }

    const bwrapAvailable = Boolean(await findBwrap(this.runner));
    const { engine: sandboxEngine } = await detectSandboxEngine(this.runner);
    const sandboxAvailable = sandboxEngine !== 'none';
    const modeFlag = options.permissionMode === 'read-only' ? 'plan' : 'accept-edits';
    const args: string[] = [
      '--output-format',
      'stream-json',
      '--mode',
      modeFlag,
    ];
    if (options.permissionMode === 'workspace-write' && sandboxAvailable) {
      args.push('--dangerously-skip-permissions');
    }

    if (options.sessionId) {
      args.push('--conversation', options.sessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    // A chosen model carries its own level in the id (or has none), so --effort only applies to the CLI default model.
    if (options.effort && !options.model) {
      args.push('--effort', options.effort);
    }
    const secrets = options.mcp?.bearerToken ? [options.mcp.bearerToken] : undefined;
    let mcpDir: string | undefined;
    if (options.mcp) {
      mcpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dalang-mcp-'));
      fs.chmodSync(mcpDir, 0o700);
      const settingsPath = path.join(mcpDir, 'settings.json');
      fs.writeFileSync(
        settingsPath,
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
      args.push('--settings', settingsPath);
    }
    args.push(`-p=${options.prompt}`);

    if (bwrapAvailable && !this.policy.antigravityKeyringAccess()) {
      if (mcpDir) fs.rmSync(mcpDir, { recursive: true, force: true });
      throw new Error(KEYRING_OFF_MESSAGE);
    }
    const dbusProxy = bwrapAvailable ? await startDbusProxy(this.runner) : null;
    if (bwrapAvailable && !dbusProxy) {
      if (mcpDir) fs.rmSync(mcpDir, { recursive: true, force: true });
      throw new Error(
        'Antigravity signs in through the desktop session bus, and a sandboxed run only gets a filtered one. Install xdg-dbus-proxy and run DALANG from a desktop session.',
      );
    }
    const invocation = await wrapWithSandbox(
      this.runner,
      this.id,
      options.projectPath,
      binaryPath,
      args,
      {
        dbusSocket: dbusProxy?.socketPath,
        readOnly: options.permissionMode === 'read-only',
        configDir: options.configDir,
        mcpDir,
      },
    );
    const env = buildProviderAccountEnv(this.id, options.configDir);

    const logger = createTurnLogger(options.logFilePath, secrets);
    let sessionId: string | null = options.sessionId ?? null;
    let resolvedModel: string | null = options.model ?? null;
    let responseText = '';
    let structuredOutput: unknown = undefined;
    let usage: TurnTokenUsage | undefined;
    const textChunks: string[] = [];

    try {
      const res = await this.runner.run(invocation.command, invocation.args, {
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
            if (typeof ev.conversation_id === 'string' && ev.conversation_id) {
              sessionId = ev.conversation_id;
            }
            if (ev.init && typeof ev.init === 'object') {
              const initObj = ev.init as Record<string, unknown>;
              if (typeof initObj.model === 'string' && initObj.model.trim()) {
                resolvedModel = initObj.model.trim();
              }
            }
            if (typeof ev.response === 'string') {
              responseText = ev.response;
            }
            if (ev.structured_output !== undefined) {
              structuredOutput = ev.structured_output;
            }
            if (ev.result && typeof ev.result === 'object') {
              const inner = ev.result as Record<string, unknown>;
              if (typeof inner.conversation_id === 'string' && inner.conversation_id) {
                sessionId = inner.conversation_id;
              }
              if (typeof inner.response === 'string') responseText = inner.response;
              if (inner.structured_output !== undefined) structuredOutput = inner.structured_output;
            }
            const parsedUsage = extractAgyUsage(ev, resolvedModel);
            if (parsedUsage) usage = parsedUsage;
            if (typeof ev.text === 'string' && ev.type !== 'thinking') {
              textChunks.push(ev.text);
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
        throw new Error(`Antigravity turn timed out (${res.idleTimedOut ? 'idle' : 'total'})`);
      }

      return {
        text: redactSecrets(responseText || textChunks.join('').trim(), secrets),
        sessionId,
        structuredOutput,
        exitCode: res.exitCode,
        stdout: redactSecrets(res.stdout, secrets),
        stderr: redactSecrets(res.stderr, secrets),
        logFilePath: options.logFilePath,
        aborted: Boolean(res.aborted),
        ...(usage ? { usage } : {}),
      };
    } finally {
      if (mcpDir) fs.rmSync(mcpDir, { recursive: true, force: true });
      logger.close();
      dbusProxy?.stop();
    }
  }
}
