import type { ProviderModelInfo } from '@dalang/shared';

/**
 * How a model is named wherever it is listed. A Claude model shows its version, like T3 Code
 * ("claude-opus-5-5" reads "Claude Opus 5.5"); other providers keep the name their CLI reports.
 */
export function modelLabel(m: Pick<ProviderModelInfo, 'displayName' | 'resolvedModel'>): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m.resolvedModel ?? '');
  if (!claude) return m.displayName;
  return `Claude ${claude[1].charAt(0).toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
}
