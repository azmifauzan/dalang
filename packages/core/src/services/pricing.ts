import type { ProviderId } from '@dalang/shared';
import type { TurnTokenUsage } from '../adapters/types.js';

export interface ModelPricingRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

/**
 * Reference API-equivalent token pricing (USD per 1M tokens) used only when a CLI
 * does not report `total_cost_usd` directly. Presented to the user as an API-equivalent
 * estimate, never as the subscription bill.
 */
const MODEL_PRICE_PATTERNS: Array<{ match: RegExp; rates: ModelPricingRates }> = [
  // Claude families
  {
    match: /opus|fable/i,
    rates: { inputPerMillion: 4.0, outputPerMillion: 20.0, cacheReadPerMillion: 0.4, cacheWritePerMillion: 5.0 },
  },
  {
    match: /sonnet/i,
    rates: { inputPerMillion: 2.0, outputPerMillion: 10.0, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
  },
  {
    match: /haiku/i,
    rates: { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 },
  },
  // OpenAI / Codex families
  {
    match: /gpt-6|gpt-5|o3|o4|codex/i,
    rates: { inputPerMillion: 2.0, outputPerMillion: 8.0, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.0 },
  },
  {
    match: /mini|spark|nano/i,
    rates: { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0.04, cacheWritePerMillion: 0.4 },
  },
  // Gemini / Antigravity families
  {
    match: /flash/i,
    rates: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0.3 },
  },
  {
    match: /gemini|neon|argon|hydrogen/i,
    rates: { inputPerMillion: 1.25, outputPerMillion: 10.0, cacheReadPerMillion: 0.125, cacheWritePerMillion: 1.25 },
  },
];

const PROVIDER_FALLBACK_RATES: Record<ProviderId, ModelPricingRates> = {
  'claude-code': {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
  },
  codex: {
    inputPerMillion: 2.0,
    outputPerMillion: 8.0,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.0,
  },
  antigravity: {
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.125,
    cacheWritePerMillion: 1.25,
  },
};

export function resolveModelPricing(provider: ProviderId, model?: string | null): ModelPricingRates {
  const m = (model ?? '').trim();
  if (m) {
    for (const entry of MODEL_PRICE_PATTERNS) {
      if (entry.match.test(m)) return entry.rates;
    }
  }
  return PROVIDER_FALLBACK_RATES[provider];
}

export function estimateApiEquivalentCostUsd(opts: {
  provider: ProviderId;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedCostUsd?: number | null;
}): { costUsd: number; source: 'cli' | 'estimated' } {
  if (typeof opts.reportedCostUsd === 'number' && Number.isFinite(opts.reportedCostUsd) && opts.reportedCostUsd >= 0) {
    return { costUsd: Number(opts.reportedCostUsd.toFixed(6)), source: 'cli' };
  }
  const rates = resolveModelPricing(opts.provider, opts.model);
  // Treat inputTokens as non-cached input if cacheReadTokens is tracked separately; clamp at 0.
  const uncachedInput = Math.max(0, opts.inputTokens);
  const cost =
    (uncachedInput * rates.inputPerMillion +
      Math.max(0, opts.outputTokens) * rates.outputPerMillion +
      Math.max(0, opts.cacheReadTokens) * rates.cacheReadPerMillion +
      Math.max(0, opts.cacheWriteTokens) * rates.cacheWritePerMillion) /
    1_000_000;
  return { costUsd: Number(cost.toFixed(6)), source: 'estimated' };
}

export function mergeTokenUsage(
  base: TurnTokenUsage | undefined,
  next: TurnTokenUsage | undefined,
): TurnTokenUsage | undefined {
  if (!base) return next;
  if (!next) return base;
  return {
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    cacheReadTokens: base.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + next.cacheWriteTokens,
    costUsd:
      base.costUsd !== null || next.costUsd !== null
        ? (base.costUsd ?? 0) + (next.costUsd ?? 0)
        : null,
    model: next.model ?? base.model,
  };
}

export function usageDbFields(
  provider: ProviderId,
  fallbackModel: string | null,
  usage: TurnTokenUsage | undefined,
): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
  costSource?: 'cli' | 'estimated';
} {
  if (!usage) return {};
  const est = estimateApiEquivalentCostUsd({
    provider,
    model: usage.model ?? fallbackModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reportedCostUsd: usage.costUsd,
  });
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    estimatedCostUsd: est.costUsd,
    costSource: est.source,
  };
}
