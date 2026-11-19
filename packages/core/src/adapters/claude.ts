import os from 'node:os';
import type { ProviderStatus, ProviderUsage, UsageWindow } from '@dalang/shared';
import { createTurnLogger } from './logger.js';
import { findBwrap, wrapWithBwrap } from './sandbox.js';
import type { AdapterTurnOptions, AdapterTurnResult, CliAdapter, CliRunner } from './types.js';

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

// The stream-json control protocol's `initialize` request returns the models this CLI offers (the same list as
// its /model picker) without any API call. Asking the CLI keeps the list correct when models change.
const CLAUDE_INITIALIZE = `${JSON.stringify({ type: 'control_request', request_id: 'dalang-init', request: { subtype: 'initialize' } })}\n`;

/** Model ids from the `initialize` control response: the resolved id of each entry, then any other value it accepts. */
export function parseClaudeInitializeModels(stdout: string): string[] {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('control_response')) continue;
    try {
      const ev = JSON.parse(line) as { response?: { response?: { models?: unknown } } };
      const models = ev.response?.response?.models;
      if (!Array.isArray(models)) continue;
      const entries = models.filter(
        (m): m is { value: string; resolvedModel?: string } => typeof m?.value === 'string' && m.value !== 'default',
      );
      const resolved = entries.map((m) => (typeof m.resolvedModel === 'string' && m.resolvedModel) || m.value);
      return [...new Set([...resolved, ...entries.map((m) => m.value)])];
    } catch {
      // Not JSON, keep reading.
    }
  }
  return [];
}

export class ClaudeCodeAdapter implements CliAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly binary = 'claude';

  constructor(private readonly runner: CliRunner) {}

  private async discoverModels(binaryPath: string): Promise<string[]> {
    const reply = await this.runner
      .run(
        binaryPath,
        ['-p', '--bare', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { cwd: os.tmpdir(), timeoutMs: 15_000, stdinData: CLAUDE_INITIALIZE },
      )
      .catch(() => null);
    return reply ? parseClaudeInitializeModels(reply.stdout) : [];
  }

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
    const [verRes, authRes] = await Promise.all([
      this.runner.run(binaryPath, ['--version'], { cwd, timeoutMs: 5000 }).catch(() => null),
      this.runner.run(binaryPath, ['auth', 'status'], { cwd, timeoutMs: 5000 }).catch(() => null),
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
        ? this.getUsage()
        : Promise.resolve({ available: false, windows: [], error: 'Not logged in' } as ProviderUsage),
      loggedIn ? this.discoverModels(binaryPath) : Promise.resolve([] as string[]),
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
        [
          '-p',
          '/usage',
          '--setting-sources',
          'project',
          '--strict-mcp-config',
        ],
        { cwd: os.homedir(), timeoutMs: 12000, idleTimeoutMs: 10000 },
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

    const bwrapAvailable = Boolean(await findBwrap(this.runner));
    const permissionFlag =
      options.permissionMode === 'read-only'
        ? 'plan'
        : options.permissionMode === 'workspace-write'
          ? bwrapAvailable
            ? 'bypassPermissions'
            : 'auto'
          : 'acceptEdits';
    const args: string[] = [
      '-p',
      options.prompt,
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

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.effort) {
      args.push('--effort', options.effort);
    }

    const invocation = await wrapWithBwrap(
      this.runner,
      this.id,
      options.projectPath,
      binaryPath,
      args,
      { readOnly: options.permissionMode === 'read-only' },
    );

    const logger = createTurnLogger(options.logFilePath);
    let sessionId: string | null = options.sessionId ?? null;
    let resultText = '';
    let structuredOutput: unknown = undefined;
    let rateLimitReason: string | undefined;
    const assistantChunks: string[] = [];

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
            if (typeof ev.session_id === 'string' && ev.session_id) {
              sessionId = ev.session_id;
            }
            if (ev.type === 'rate_limit_event') {
              const info = (ev.rate_limit_info && typeof ev.rate_limit_info === 'object'
                ? ev.rate_limit_info
                : ev) as Record<string, unknown>;
              const status = typeof info.status === 'string' ? info.status.toLowerCase() : '';
              const util = typeof info.utilization === 'number' ? info.utilization : null;
              if (status === 'rejected' || (util !== null && util >= 1)) {
                const win = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'quota';
                rateLimitReason = `Claude rate_limit_event (${win}: ${status || `${Math.round((util ?? 1) * 100)}%`})`;
              }
            }
            if (ev.type === 'result') {
              if (typeof ev.result === 'string') resultText = ev.result;
              if (ev.structured_output !== undefined) structuredOutput = ev.structured_output;
            }
            if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
              const msg = ev.message as { content?: Array<{ type?: string; text?: string }> };
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
          logger.write(`[stderr] ${line}`);
          options.onLogLine?.(`[stderr] ${line}`);
        },
      });

      const text = resultText || assistantChunks.join('\n').trim();
      if (!res.aborted && (res.timedOut || res.idleTimedOut)) {
        throw new Error(`Claude turn timed out (${res.idleTimedOut ? 'idle' : 'total'})`);
      }

      return {
        text,
        sessionId,
        structuredOutput,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        logFilePath: options.logFilePath,
        aborted: Boolean(res.aborted),
        ...(rateLimitReason ? { rateLimitReason } : {}),
      };
    } finally {
      logger.close();
    }
  }
}
