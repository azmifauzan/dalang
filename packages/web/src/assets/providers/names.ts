import type { ProviderId } from '@dalang/shared';

/** What people call each CLI, instead of its internal id such as "claude-code". */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
};
