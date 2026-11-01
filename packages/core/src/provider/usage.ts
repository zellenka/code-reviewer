import type { ModelPricing, Usage } from './types';

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
}

/** Sums usage. The result is `estimated` if any part was. */
export function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    requests: a.requests + b.requests,
  };
  if (a.estimated || b.estimated) sum.estimated = true;
  return sum;
}

/**
 * Cost in USD. `inputTokens` is uncached input; cache reads and writes are
 * priced separately (falling back to 0.1x / 1.25x the input price).
 */
export function estimateCostUsd(usage: Usage, pricing: ModelPricing): number {
  const cacheRead = pricing.cacheReadPerMTok ?? pricing.inputPerMTok * 0.1;
  const cacheWrite = pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25;
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWriteTokens ?? 0) * cacheWrite) /
    1_000_000
  );
}

/** Rough local token estimate (~3.5 chars per token) for providers without a tokenizer endpoint. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
