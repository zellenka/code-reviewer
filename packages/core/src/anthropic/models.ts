import type { ModelInfo, ModelPricing } from '../provider/types';

/**
 * Built-in Anthropic model table (prices in USD per million tokens, checked 2026-11).
 * Users can override or extend it via settings (`aiReview.anthropic.models`).
 * Cache writes are priced at 1.25x input (5-minute TTL).
 */
export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  model('claude-opus-5-5', 'Claude Opus 5.5', {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
  }),
  model('claude-sonnet-5-5', 'Claude Sonnet 5.5', {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
  }),
  // Haiku 5.5 prices are for prompts up to 100K tokens ($0.50 / $2.50 beyond).
  model('claude-haiku-5-5', 'Claude Haiku 5.5', { inputPerMTok: 0.1, outputPerMTok: 0.5 }),
  model('claude-fable-5-1', 'Claude Fable 5.1', {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
  }),
];

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
export const REFUSAL_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-opus-5',
]);

function model(id: string, name: string, pricing: ModelPricing): ModelInfo {
  return {
    id,
    name,
    vendor: 'anthropic',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    pricing: { cacheWritePerMTok: pricing.inputPerMTok * 1.25, ...pricing },
  };
}

/** A settings entry: `id` is required, everything else overrides or fills in defaults. */
export type ModelOverride = { id: string } & Partial<Omit<ModelInfo, 'id'>>;

/**
 * Applies overrides by id. Unknown ids become new models (defaults: 200K in,
 * 32K out, tools supported, no pricing). Invalid entries are ignored.
 */
export function mergeModels(
  base: readonly ModelInfo[],
  overrides: readonly unknown[] = [],
): ModelInfo[] {
  const result = base.map((m) => ({ ...m }));
  for (const raw of overrides) {
    if (!isOverride(raw)) continue;
    const existing = result.find((m) => m.id === raw.id);
    if (existing) {
      Object.assign(
        existing,
        raw,
        raw.pricing ? { pricing: { ...existing.pricing, ...raw.pricing } } : {},
      );
    } else {
      result.push({
        name: raw.id,
        vendor: 'anthropic',
        maxInputTokens: 200_000,
        maxOutputTokens: 32_000,
        supportsTools: true,
        ...raw,
      });
    }
  }
  return result;
}

function isOverride(value: unknown): value is ModelOverride {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0
  );
}
