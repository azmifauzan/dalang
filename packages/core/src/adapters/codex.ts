import fs from 'node:fs';
import os from 'node:os';
import type { ProviderStatus, ProviderUsage, UsageWindow } from '@dalang/shared';
import { createTurnLogger } from './logger.js';
import { findBwrap, wrapWithBwrap } from './sandbox.js';
import type { AdapterTurnOptions, AdapterTurnResult, CliAdapter, CliRunner } from './types.js';

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

export function parseCodexModelsJson(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { models?: Array<{ slug?: string; visibility?: string }> };
    return (parsed.models ?? [])
      .filter((m) => typeof m.slug === 'string' && (m.visibility ?? 'list') === 'list')
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly binary = 'codex';

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
    const [verRes, authRes, modelsRes] = await Promise.all([
      this.runner.run(binaryPath, ['--version'], { cwd, timeoutMs: 5000 }).catch(() => null),
      this.runner.run(binaryPath, ['login', 'status'], { cwd, timeoutMs: 5000 }).catch(() => null),
      this.runner.run(binaryPath, ['debug', 'models'], { cwd, timeoutMs: 10000 }).catch(() => null),
    ]);
    const models = modelsRes ? parseCodexModelsJson(modelsRes.stdout) : [];

    const version = verRes?.stdout.trim() || null;
    const authOut = `${authRes?.stdout ?? ''}\n${authRes?.stderr ?? ''}`.trim();
    const loggedIn = /logged\s*in/i.test(authOut) && !/not\s*logged\s*in/i.test(authOut);
    const authSummary = authOut ? authOut.split(/\r?\n/)[0].trim() : 'Unknown login status';

    const usage = loggedIn
      ? await this.getUsage()
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
      let controls: {
        writeStdin: (data: string) => void;
        endStdin: () => void;
        kill: () => void;
      } | null = null;
      let rateLimitsSent = false;
      let parsedWindows: UsageWindow[] = [];

      const res = await this.runner.run(binaryPath, ['app-server'], {
        cwd: os.homedir(),
        interactiveStdin: true,
        timeoutMs: 8000,
        idleTimeoutMs: 5000,
        onSpawn: (c) => {
          controls = c;
          c.writeStdin(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { clientInfo: { name: 'dalang', version: '0.1.0' } },
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
    // so when bwrap is the boundary Codex runs unsandboxed inside it.
    const sandboxMode = (await findBwrap(this.runner)) ? 'danger-full-access' : 'workspace-write';
    args.push('-c', `sandbox_mode="${sandboxMode}"`);
    if (options.model) {
      args.push('-m', options.model);
    }
    if (options.effort) {
      args.push('-c', `model_reasoning_effort="${options.effort}"`);
    }
    if (options.schemaFilePath) {
      args.push('--output-schema', options.schemaFilePath);
    }
    if (options.outputFilePath) {
      args.push('-o', options.outputFilePath);
    }
    args.push(options.prompt);

    const invocation = await wrapWithBwrap(
      this.runner,
      this.id,
      options.projectPath,
      binaryPath,
      args,
    );

    const logger = createTurnLogger(options.logFilePath);
    let sessionId: string | null = options.sessionId ?? null;
    const messages: string[] = [];

    try {
      const res = await this.runner.run(invocation.command, invocation.args, {
        cwd: options.projectPath,
        timeoutMs: options.timeoutMs ?? 600_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 180_000,
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
          } catch {
            // ignore non-JSON
          }
        },
        onStderrLine: (line) => {
          logger.write(`[stderr] ${line}`);
          options.onLogLine?.(`[stderr] ${line}`);
        },
      });

      if (res.timedOut || res.idleTimedOut) {
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
      };
    } finally {
      logger.close();
    }
  }
}
