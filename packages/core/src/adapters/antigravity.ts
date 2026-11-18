import os from 'node:os';
import type { ProviderStatus, ProviderUsage, UsageWindow } from '@dalang/shared';
import { createTurnLogger } from './logger.js';
import { findBwrap, startDbusProxy, wrapWithBwrap } from './sandbox.js';
import type { AdapterTurnOptions, AdapterTurnResult, CliAdapter, CliRunner } from './types.js';

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

export function parseAgyModelsOutput(stdout: string): string[] {
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Fetching')) continue;
    const id = trimmed.split(/\s+/)[0];
    if (id && /^[a-z0-9][a-z0-9._-]+$/i.test(id)) {
      models.push(id);
    }
  }
  return models;
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

export class AntigravityAdapter implements CliAdapter {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity CLI';
  readonly binary = 'agy';

  constructor(private readonly runner: CliRunner) {}

  async checkStatus(): Promise<ProviderStatus> {
    const checkedAt = new Date().toISOString();
    const binaryPath = await this.runner.which(this.binary);
    const bwrapPath = await this.runner.which('bwrap');
    const sandboxReady = Boolean(bwrapPath && process.platform === 'linux');

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
        models: [],
        usage: { available: false, windows: [], error: 'Not installed' },
        checkedAt,
      };
    }

    const cwd = os.homedir();
    const [verRes, modelsRes, usage] = await Promise.all([
      this.runner.run(binaryPath, ['--version'], { cwd, timeoutMs: 5000 }).catch(() => null),
      this.runner.run(binaryPath, ['models'], { cwd, timeoutMs: 10000 }).catch(() => null),
      this.getUsage(),
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
      models,
      usage,
      checkedAt,
    };
  }

  async getUsage(): Promise<ProviderUsage> {
    const binaryPath = await this.runner.which(this.binary);
    if (!binaryPath) {
      return { available: false, windows: [], error: 'Binary not installed' };
    }
    try {
      const res = await this.runner.run(
        binaryPath,
        ['-p=/usage', '--output-format', 'json'],
        { cwd: os.homedir(), timeoutMs: 10000, idleTimeoutMs: 8000 },
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
    const modeFlag = options.permissionMode === 'read-only' ? 'plan' : 'accept-edits';
    const args: string[] = [
      '--output-format',
      'stream-json',
      '--mode',
      modeFlag,
    ];
    if (options.permissionMode === 'workspace-write' && bwrapAvailable) {
      args.push('--dangerously-skip-permissions');
    }

    if (options.sessionId) {
      args.push('--conversation', options.sessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.effort) {
      args.push('--effort', options.effort);
    }
    args.push(`-p=${options.prompt}`);

    const dbusProxy = bwrapAvailable ? await startDbusProxy(this.runner) : null;
    if (bwrapAvailable && !dbusProxy) {
      throw new Error(
        'Antigravity signs in through the desktop session bus, and a sandboxed run only gets a filtered one. Install xdg-dbus-proxy and run DALANG from a desktop session.',
      );
    }
    const invocation = await wrapWithBwrap(
      this.runner,
      this.id,
      options.projectPath,
      binaryPath,
      args,
      { dbusSocket: dbusProxy?.socketPath },
    );

    const logger = createTurnLogger(options.logFilePath);
    let sessionId: string | null = options.sessionId ?? null;
    let responseText = '';
    let structuredOutput: unknown = undefined;
    const textChunks: string[] = [];

    try {
      const res = await this.runner.run(invocation.command, invocation.args, {
        cwd: options.projectPath,
        timeoutMs: options.timeoutMs ?? 600_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 180_000,
        signal: options.signal,
        onStdoutLine: (line) => {
          logger.write(line);
          options.onLogLine?.(line);
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>;
            if (typeof ev.conversation_id === 'string' && ev.conversation_id) {
              sessionId = ev.conversation_id;
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
            if (typeof ev.text === 'string' && ev.type !== 'thinking') {
              textChunks.push(ev.text);
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
        throw new Error(`Antigravity turn timed out (${res.idleTimedOut ? 'idle' : 'total'})`);
      }

      return {
        text: responseText || textChunks.join('').trim(),
        sessionId,
        structuredOutput,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        logFilePath: options.logFilePath,
        aborted: Boolean(res.aborted),
      };
    } finally {
      logger.close();
      dbusProxy?.stop();
    }
  }
}
