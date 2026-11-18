import type { ProviderId, ProviderStatus } from '@dalang/shared';
import { AntigravityAdapter, KEYRING_OFF_MESSAGE } from './antigravity.js';
import { ClaudeCodeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { findBwrap, NodeCliRunner } from './sandbox.js';
import type { CliAdapter, CliRunner } from './types.js';

export interface ProviderPolicy {
  /** True when the user allowed sandboxed Antigravity runs to read the desktop keyring. */
  antigravityKeyringAccess: () => boolean;
}

export class ProviderRegistry {
  private readonly adapters: Map<ProviderId, CliAdapter>;
  private readonly runner: CliRunner;

  private readonly policy: ProviderPolicy;

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

  async checkAllStatuses(): Promise<ProviderStatus[]> {
    const list = Array.from(this.adapters.values());
    return Promise.all(list.map((adapter) => adapter.checkStatus()));
  }
}
