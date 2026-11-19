import { z } from 'zod';
import type { LLMProvider, ModelInfo, ModelPricing } from './types';

/** Token limits feed the chunk budget: positive safe integers, not "200k", NaN or 1e300. */
export const tokenLimitSchema = z.number().int().positive();
/** USD per million tokens. */
export const priceSchema = z.number().nonnegative();
const minTokensSchema = z.number().int().nonnegative();

export interface ParseModelOptions {
  /** Used when the model names no vendor. Default: empty. */
  vendor?: string;
  warn?: (message: string) => void;
}

/**
 * Checks one model a provider lists, before any budget, chunk, cost or picker code sees it
 * (A6). Returns undefined for a model without an id or with an unusable token limit: no
 * review can be sized for it, so it is not offered. Everything else is repaired: a missing
 * name becomes the id, a missing vendor `options.vendor`, a non-boolean `supportsTools`
 * false (JSON-only reviews work with every model), and invalid pricing or prompt caching
 * is dropped (no cost estimate rather than NaN; an invalid cache price alone falls back
 * to the input price). Unknown fields are left out. Each problem is reported through
 * `warn`. Never mutates `raw`.
 */
export function parseModelInfo(
  raw: unknown,
  options: ParseModelOptions = {},
): ModelInfo | undefined {
  const warn = options.warn ?? (() => {});
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
    warn('a model without an id (not offered)');
    return undefined;
  }
  const { id } = raw;
  const label = `model "${id}"`;
  for (const field of ['maxInputTokens', 'maxOutputTokens'] as const) {
    if (!tokenLimitSchema.safeParse(raw[field]).success) {
      warn(
        `${label}: ${field} ${String(raw[field])} is not a positive whole number of tokens (not offered)`,
      );
      return undefined;
    }
  }
  const model: ModelInfo = {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
    vendor: typeof raw.vendor === 'string' ? raw.vendor : (options.vendor ?? ''),
    maxInputTokens: raw.maxInputTokens as number,
    maxOutputTokens: raw.maxOutputTokens as number,
    supportsTools: raw.supportsTools === true,
  };
  if (model.name !== raw.name) warn(`${label}: no name (using the id)`);
  if (model.vendor !== raw.vendor) warn(`${label}: no vendor`);
  if (typeof raw.supportsTools !== 'boolean') {
    warn(`${label}: supportsTools is not true or false (reviewing without tools)`);
  }
  if (raw.pricing !== undefined) {
    const pricing = parsePricing(raw.pricing, (problem) => warn(`${label}: ${problem}`));
    if (pricing) model.pricing = pricing;
  }
  if (raw.promptCaching !== undefined) {
    const minTokens = isRecord(raw.promptCaching) ? raw.promptCaching.minTokens : undefined;
    if (minTokensSchema.safeParse(minTokens).success) {
      model.promptCaching = { minTokens: minTokens as number };
    } else {
      warn(`${label}: promptCaching needs a whole minTokens of 0 or more (ignored)`);
    }
  }
  return model;
}

function parsePricing(raw: unknown, warn: (problem: string) => void): ModelPricing | undefined {
  const valid = (value: unknown) => priceSchema.safeParse(value).success;
  if (!isRecord(raw) || !valid(raw.inputPerMTok) || !valid(raw.outputPerMTok)) {
    // Without both base prices the cost estimate would be NaN.
    warn('pricing needs inputPerMTok and outputPerMTok of 0 or more (ignored)');
    return undefined;
  }
  const pricing: ModelPricing = {
    inputPerMTok: raw.inputPerMTok as number,
    outputPerMTok: raw.outputPerMTok as number,
  };
  for (const field of ['cacheReadPerMTok', 'cacheWritePerMTok'] as const) {
    if (raw[field] === undefined) continue;
    if (valid(raw[field])) pricing[field] = raw[field] as number;
    else warn(`pricing.${field} ${String(raw[field])} is not a price (ignored)`);
  }
  return pricing;
}

/**
 * `provider`, listing its models through `parseModelInfo` (A6): hosts wrap each provider
 * they hand out (the extension's registry, the evals), so no review, estimate or picker
 * sees an unusable limit. Each problem is reported once, prefixed with the provider id:
 * `listModels` runs on every request.
 */
export function withModelValidation(
  provider: LLMProvider,
  warn: (message: string) => void = () => {},
): LLMProvider {
  const reported = new Set<string>();
  const report = (message: string) => {
    const line = `${provider.id}: ${message}`;
    if (reported.has(line)) return;
    reported.add(line);
    warn(line);
  };
  return {
    id: provider.id,
    listModels: async () => {
      const models: unknown = await provider.listModels();
      if (!Array.isArray(models)) {
        report('listModels did not return a list (no models offered)');
        return [];
      }
      return models.flatMap((raw) => {
        const model = parseModelInfo(raw, { vendor: provider.id, warn: report });
        return model ? [model] : [];
      });
    },
    countTokens: (model, text) => provider.countTokens(model, text),
    chat: (req) => provider.chat(req),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
