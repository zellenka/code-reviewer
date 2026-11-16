import { z } from 'zod';
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
    // Minimum cacheable prefix on current Anthropic models (checked 2026-11).
    promptCaching: { minTokens: 512 },
  };
}

const tokenLimit = z.number().int().positive();
const price = z.number().nonnegative();

/**
 * A settings entry: `id` is required, everything else overrides or fills in defaults.
 * Token limits feed the chunk budget, so they must be positive integers (not "200k").
 */
const modelOverrideSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    maxInputTokens: tokenLimit.optional(),
    maxOutputTokens: tokenLimit.optional(),
    supportsTools: z.boolean().optional(),
    pricing: z
      .object({
        inputPerMTok: price.optional(),
        outputPerMTok: price.optional(),
        cacheReadPerMTok: price.optional(),
        cacheWritePerMTok: price.optional(),
      })
      .strict()
      .optional(),
    promptCaching: z.object({ minTokens: z.number().int().nonnegative() }).strict().optional(),
  })
  .strict();

export type ModelOverride = z.infer<typeof modelOverrideSchema>;

/**
 * Applies overrides by id. Unknown ids become new models (defaults: 200K in,
 * 32K out, tools supported, no pricing). Invalid fields are dropped one by one (the
 * valid ones of the same entry are kept); entries without an `id` are ignored.
 * Each problem is reported through `warn`.
 */
export function mergeModels(
  base: readonly ModelInfo[],
  overrides: readonly unknown[] = [],
  warn: (message: string) => void = () => {},
): ModelInfo[] {
  const result = base.map((m) => ({ ...m }));
  for (const raw of overrides) {
    const override = parseOverride(raw, warn);
    if (!override) continue;
    const existing = result.find((m) => m.id === override.id);
    if (existing) {
      Object.assign(
        existing,
        override,
        override.pricing ? { pricing: { ...existing.pricing, ...override.pricing } } : {},
      );
      continue;
    }
    const { pricing, ...rest } = override;
    const added: ModelInfo = {
      name: override.id,
      vendor: 'anthropic',
      maxInputTokens: 200_000,
      maxOutputTokens: 32_000,
      supportsTools: true,
      ...rest,
    };
    if (pricing) {
      // Without both base prices the cost estimate would be NaN.
      const { inputPerMTok, outputPerMTok } = pricing;
      if (inputPerMTok !== undefined && outputPerMTok !== undefined) {
        added.pricing = { ...pricing, inputPerMTok, outputPerMTok };
      } else {
        warn(`${label(override.id)}: pricing needs inputPerMTok and outputPerMTok (ignored)`);
      }
    }
    result.push(added);
  }
  return result;
}

const label = (id: string) => `aiReview.anthropic.models "${id}"`;

/** Validates one entry; drops invalid fields with a warning. Never mutates `raw`. */
function parseOverride(raw: unknown, warn: (message: string) => void): ModelOverride | undefined {
  const parsed = modelOverrideSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const id = isRecord(raw) ? raw.id : undefined;
  if (typeof id !== 'string' || !id) {
    warn('aiReview.anthropic.models: an entry without an "id" (ignored)');
    return undefined;
  }
  const cleaned: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const issue of parsed.error.issues) {
    const [field, sub] = issue.path.map(String);
    const nested = field !== undefined && isRecord(cleaned[field]);
    // Copy before deleting: settings objects may be frozen.
    const target = nested ? (cleaned[field] = { ...(cleaned[field] as object) }) : cleaned;
    if (issue.code === 'unrecognized_keys') {
      warn(`${label(id)}: unknown key(s) ${issue.keys.join(', ')} (ignored)`);
      for (const key of issue.keys) delete (target as Record<string, unknown>)[key];
      continue;
    }
    warn(`${label(id)}: ${issue.path.join('.')}: ${issue.message} (ignored)`);
    if (nested && sub !== undefined) delete (target as Record<string, unknown>)[sub];
    else if (field !== undefined) delete cleaned[field];
  }
  const retry = modelOverrideSchema.safeParse(cleaned);
  if (retry.success) return retry.data;
  // Removing a required nested field (promptCaching.minTokens) leaves its object
  // invalid: drop the whole object, already reported above.
  for (const issue of retry.error.issues) {
    const field = issue.path[0];
    if (field !== undefined && field !== 'id') delete cleaned[String(field)];
  }
  const last = modelOverrideSchema.safeParse(cleaned);
  if (last.success) return last.data;
  warn(`${label(id)}: invalid entry (ignored)`);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
