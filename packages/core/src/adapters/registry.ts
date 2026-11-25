import os from 'node:os';
import {
  buildAccountKey,
  type ProviderCliUpdateResultDTO,
  type ProviderId,
  type ProviderStatus,
  type ProviderUsage,
  type SandboxEngine,
  type UsageWindow,
} from '@dalang/shared';
import { AntigravityAdapter, KEYRING_OFF_MESSAGE } from './antigravity.js';
import { ClaudeCodeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import {
  detectSandboxEngine,
  NodeCliRunner,
  wrapWithSandbox,
} from './sandbox.js';
import type { CliAdapter, CliRunner, RunCommandResult } from './types.js';

export interface ProviderPolicy {
  /** True when the user allowed sandboxed Antigravity runs to read the desktop keyring. */
  antigravityKeyringAccess: () => boolean;
}

export interface UsageSnapshot {
  usage: ProviderUsage;
  checkedAt: number;
}

const STALE_USAGE_MS = 15 * 60_000;

// An exhausted reading expires at its reset time, or after 15 minutes when no reset time is known.
function windowExhausted(w: UsageWindow, ageMs: number): boolean {
  const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (Number.isFinite(resetMs)) {
    if (resetMs <= Date.now()) return false;
  } else if (ageMs > STALE_USAGE_MS) {
    return false;
  }
  if (w.remainingPercent !== null && w.remainingPercent <= 0) return true;
  if (w.usedPercent !== null && w.usedPercent >= 100) return true;
  return false;
}

export class ProviderRegistry {
  private readonly adapters: Map<ProviderId, CliAdapter>;
  private readonly runner: CliRunner;
  private readonly policy: ProviderPolicy;
  private readonly usageCache = new Map<string, UsageSnapshot>();
  private readonly rateLimitClearedAt = new Map<string, number>();
  private readonly cliUpdates = new Set<ProviderId>();
  private readonly activeTurns = new Map<ProviderId, number>();

  constructor(
    runner: CliRunner = new NodeCliRunner(),
    policy: ProviderPolicy = { antigravityKeyringAccess: () => false },
  ) {
    this.runner = runner;
    this.policy = policy;
    const adapters = [new ClaudeCodeAdapter(runner), new CodexAdapter(runner), new AntigravityAdapter(runner, policy)];
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, {
      id: adapter.id,
      displayName: adapter.displayName,
      binary: adapter.binary,
      checkStatus: (configDir) => adapter.checkStatus(configDir),
      getUsage: (configDir) => adapter.getUsage(configDir),
      runTurn: async (options) => {
        const { id } = adapter;
        if (this.cliUpdates.has(id)) throw Object.assign(new Error('This CLI is updating. Try again when it finishes.'), { statusCode: 409 });
        this.activeTurns.set(id, (this.activeTurns.get(id) ?? 0) + 1);
        try {
          return await adapter.runTurn(options);
        } finally {
          const remaining = this.activeTurns.get(id)! - 1;
          if (remaining) this.activeTurns.set(id, remaining);
          else this.activeTurns.delete(id);
        }
      },
    }]));
  }

  getRunner(): CliRunner {
    return this.runner;
  }

  async getSandboxEngine(): Promise<SandboxEngine> {
    return (await detectSandboxEngine(this.runner)).engine;
  }

  async isSandboxReady(): Promise<boolean> {
    return (await this.getSandboxEngine()) !== 'none';
  }

  /** Why a provider cannot run right now, or null. Agy in the Linux bwrap sandbox needs the user's keyring opt-in. */
  providerBlockedReason(provider: ProviderId, sandboxReady: boolean): string | null {
    if (
      provider === 'antigravity' &&
      sandboxReady &&
      process.platform === 'linux' &&
      !this.policy.antigravityKeyringAccess()
    ) {
      return KEYRING_OFF_MESSAGE;
    }
    return null;
  }

  getAdapter(id: ProviderId): CliAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown provider: ${id}`);
    }
    return adapter;
  }

  async updateCli(id: ProviderId): Promise<void> {
    const adapter = this.getAdapter(id);
    if (this.cliUpdates.has(id) || this.activeTurns.has(id)) {
      throw Object.assign(new Error('Wait for active turns or updates to finish before updating this CLI.'), { statusCode: 409 });
    }
    this.cliUpdates.add(id);
    try {
      const binary = await this.runner.which(adapter.binary);
      if (!binary) throw new Error(`${adapter.displayName} is not installed.`);
      const result = await this.runner.run(binary, ['update'], {
        cwd: os.homedir(), timeoutMs: 300_000, idleTimeoutMs: 0, env: { CI: '1', CODEX_NON_INTERACTIVE: '1' },
      });
      if (result.timedOut) throw new Error(`${adapter.displayName} update timed out.`);
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).slice(-800);
        throw new Error(`${adapter.displayName} update failed.${detail ? ` ${detail}` : ''}`);
      }
    } finally {
      this.cliUpdates.delete(id);
    }
  }

  /**
   * Updates every connected provider CLI (`installed && loggedIn`) sequentially so each adapter's
   * status and version are refreshed cleanly and one failure does not block the rest.
   */
  async updateConnectedClis(
    options: {
      statuses?: ProviderStatus[];
      onProgress?: (line: string) => void;
    } = {},
  ): Promise<{ results: ProviderCliUpdateResultDTO[]; providers: ProviderStatus[] }> {
    const initialStatuses = options.statuses ?? (await this.checkAllStatuses());
    const results: ProviderCliUpdateResultDTO[] = [];
    const updatedProviders: ProviderStatus[] = [];

    for (const status of initialStatuses) {
      if (!status.installed) {
        results.push({
          provider: status.id,
          displayName: status.displayName,
          binary: status.binary,
          status: 'skipped',
          beforeVersion: null,
          afterVersion: null,
          message: 'Not installed',
        });
        updatedProviders.push(status);
        continue;
      }
      if (!status.loggedIn) {
        results.push({
          provider: status.id,
          displayName: status.displayName,
          binary: status.binary,
          status: 'skipped',
          beforeVersion: status.version,
          afterVersion: status.version,
          message: 'Not connected (login needed)',
        });
        updatedProviders.push(status);
        continue;
      }

      options.onProgress?.(`Updating ${status.displayName} (${status.binary})...`);
      try {
        await this.updateCli(status.id);
        const refreshed = await this.getAdapter(status.id).checkStatus();
        if (refreshed.loggedIn) {
          this.setUsageSnapshot(refreshed.id, refreshed.usage, Date.now());
        }
        updatedProviders.push(refreshed);
        const before = status.version;
        const after = refreshed.version;
        const versionText =
          before && after && before !== after
            ? `${before} -> ${after}`
            : after
              ? `${after} (up to date)`
              : 'Updated';
        results.push({
          provider: status.id,
          displayName: status.displayName,
          binary: status.binary,
          status: 'updated',
          beforeVersion: before,
          afterVersion: after,
          message: versionText,
        });
      } catch (err) {
        updatedProviders.push(status);
        results.push({
          provider: status.id,
          displayName: status.displayName,
          binary: status.binary,
          status: 'failed',
          beforeVersion: status.version,
          afterVersion: status.version,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { results, providers: updatedProviders };
  }

  getCachedUsage(provider: ProviderId, configDir?: string | null): UsageSnapshot | null {
    const key = buildAccountKey(provider, configDir);
    return this.usageCache.get(key) ?? null;
  }

  getRateLimitClearedAt(provider: ProviderId, configDir?: string | null): number {
    const key = buildAccountKey(provider, configDir);
    return this.rateLimitClearedAt.get(key) ?? 0;
  }

  clearCooldown(provider: ProviderId, configDir?: string | null): void {
    const key = buildAccountKey(provider, configDir);
    this.rateLimitClearedAt.set(key, Date.now());
  }

  clearCooldownByAccountKey(accountKey: string): void {
    this.rateLimitClearedAt.set(accountKey, Date.now());
  }

  setUsageSnapshot(
    provider: ProviderId,
    usage: ProviderUsage,
    checkedAt: number = Date.now(),
    configDir?: string | null,
  ): void {
    const key = buildAccountKey(provider, configDir);
    this.usageCache.set(key, { usage, checkedAt });
  }

  /**
   * Check whether a cached `ProviderUsage` indicates quota is completely exhausted.
   * For multi-group providers like Antigravity, checks matching group when model hints match,
   * otherwise requires all groups or any global window to be exhausted.
   */
  isUsageExhausted(
    usage: ProviderUsage | null | undefined,
    model?: string | null,
    ageMs = 0,
  ): string | null {
    if (!usage || !usage.available || usage.windows.length === 0) return null;

    const modelLower = model?.toLowerCase().trim() ?? '';
    const groups = new Set(usage.windows.map((w) => w.group));
    if (groups.size > 1 && modelLower) {
      const matching = usage.windows.filter((w) => {
        const g = w.group.toLowerCase();
        if (modelLower.includes('claude') && g.includes('claude')) return true;
        if (modelLower.includes('gemini') && g.includes('gemini')) return true;
        if (modelLower.includes('gpt') && (g.includes('gpt') || g.includes('openai'))) return true;
        return false;
      });
      if (matching.length > 0) {
        const hit = matching.find((w) => windowExhausted(w, ageMs));
        return hit ? `Quota exhausted (${hit.label}: 0% remaining)` : null;
      }
    }

    if (groups.size > 1) {
      const allGroupsExhausted = [...groups].every((groupName) =>
        usage.windows.filter((w) => w.group === groupName).some((w) => windowExhausted(w, ageMs)),
      );
      if (allGroupsExhausted) {
        return 'All quota model groups are exhausted (0% remaining)';
      }
      return null;
    }

    const hit = usage.windows.find((w) => windowExhausted(w, ageMs));
    return hit ? `Quota exhausted (${hit.label}: 0% remaining)` : null;
  }

  async refreshUsage(provider: ProviderId, configDir?: string | null): Promise<ProviderUsage> {
    const adapter = this.getAdapter(provider);
    const usage = await adapter.getUsage(configDir);
    this.setUsageSnapshot(provider, usage, Date.now(), configDir);
    return usage;
  }

  async checkAllStatuses(): Promise<ProviderStatus[]> {
    const list = Array.from(this.adapters.values());
    const statuses = await Promise.all(list.map((adapter) => adapter.checkStatus()));
    const now = Date.now();
    for (const status of statuses) {
      if (status.loggedIn) {
        this.setUsageSnapshot(status.id, status.usage, now);
      }
    }
    return statuses;
  }

  /** Run a project verify or integration command inside the platform sandbox when available, without provider state dirs. */
  async runShellCommand(
    projectPath: string,
    command: string,
    options: {
      timeoutMs?: number;
      idleTimeoutMs?: number;
      signal?: AbortSignal;
      onLogLine?: (line: string) => void;
    } = {},
  ): Promise<RunCommandResult> {
    const invocation = await wrapWithSandbox(
      this.runner,
      null,
      projectPath,
      process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
      { bindProviderDirs: false },
    );
    return this.runner.run(invocation.command, invocation.args, {
      cwd: projectPath,
      timeoutMs: options.timeoutMs ?? 300_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
      signal: options.signal,
      onStdoutLine: options.onLogLine,
      onStderrLine: (line) => options.onLogLine?.(`[stderr] ${line}`),
    });
  }
}
