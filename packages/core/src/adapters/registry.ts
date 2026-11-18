import type { ProviderId, ProviderStatus } from '@dalang/shared';
import { AntigravityAdapter } from './antigravity.js';
import { ClaudeCodeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { findBwrap, NodeCliRunner } from './sandbox.js';
import type { CliAdapter, CliRunner } from './types.js';

export class ProviderRegistry {
  private readonly adapters: Map<ProviderId, CliAdapter>;
  private readonly runner: CliRunner;

  constructor(runner: CliRunner = new NodeCliRunner()) {
    this.runner = runner;
    this.adapters = new Map<ProviderId, CliAdapter>([
      ['claude-code', new ClaudeCodeAdapter(runner)],
      ['codex', new CodexAdapter(runner)],
      ['antigravity', new AntigravityAdapter(runner)],
    ]);
  }

  async isSandboxReady(): Promise<boolean> {
    return Boolean(await findBwrap(this.runner));
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
