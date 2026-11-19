import type { ProviderId, ProviderStatus, ProviderUsage, UsageWindow } from '@dalang/shared';
import { AntigravityAdapter, KEYRING_OFF_MESSAGE } from './antigravity.js';
import { ClaudeCodeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { findBwrap, NodeCliRunner, wrapWithBwrap } from './sandbox.js';
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
  private readonly usageCache = new Map<ProviderId, UsageSnapshot>();
  private readonly rateLimitClearedAt = new Map<ProviderId, number>();

  constructor(
    runner: CliRunner = new NodeCliRunner(),
    policy: ProviderPolicy = { antigravityKeyringAccess: () => false },
  ) {
    this.runner = runner;
    this.policy = policy;
    this.adapters = new Map<ProviderId, CliAdapter>([
      ['claude-code', new ClaudeCodeAdapter(runner)],
      ['codex', new CodexAdapter(runner)],
      ['antigravity', new AntigravityAdapter(runner, policy)],
    ]);
  }

  async isSandboxReady(): Promise<boolean> {
    return Boolean(await findBwrap(this.runner));
  }

  /** Why a provider cannot run right now, or null. Agy in the sandbox needs the user's keyring opt-in. */
  providerBlockedReason(provider: ProviderId, sandboxReady: boolean): string | null {
    if (provider === 'antigravity' && sandboxReady && !this.policy.antigravityKeyringAccess()) {
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

  getCachedUsage(provider: ProviderId): UsageSnapshot | null {
    return this.usageCache.get(provider) ?? null;
  }

  getRateLimitClearedAt(provider: ProviderId): number {
    return this.rateLimitClearedAt.get(provider) ?? 0;
  }

  clearCooldown(provider: ProviderId): void {
    this.rateLimitClearedAt.set(provider, Date.now());
  }

  setUsageSnapshot(provider: ProviderId, usage: ProviderUsage, checkedAt: number = Date.now()): void {
    this.usageCache.set(provider, { usage, checkedAt });
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

  async refreshUsage(provider: ProviderId): Promise<ProviderUsage> {
    const adapter = this.getAdapter(provider);
    const usage = await adapter.getUsage();
    this.setUsageSnapshot(provider, usage);
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

  /** Run a project verify or integration command inside bwrap when available, without provider state dirs. */
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
    const invocation = await wrapWithBwrap(
      this.runner,
      null,
      projectPath,
      '/bin/sh',
      ['-c', command],
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
