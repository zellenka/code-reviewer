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

/** ASCII characters per token in {@link estimateTokens}. */
const ASCII_PER_TOKEN = 3.5;
/** Cost of a code point below U+0800 (accented Latin, Greek, Cyrillic, Hebrew, Arabic...), in ASCII characters: half a token. */
const NARROW_WEIGHT = ASCII_PER_TOKEN / 2;
/** Cost of any other code point (CJK, kana, Hangul, Indic, symbols, emoji), in ASCII characters: a token. */
const WIDE_WEIGHT = ASCII_PER_TOKEN;
const NON_ASCII = /[\u0080-\uffff]/;

/**
 * Walks `text` adding up each code point's cost in ASCII characters, and stops before the
 * code point that would take the total over `limit`. Returns the total and where it stopped.
 */
function scan(text: string, limit: number): { weight: number; end: number } {
  let weight = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    let w = 1;
    let size = 1;
    if (c >= 0x80) {
      w = c < 0x800 ? NARROW_WEIGHT : WIDE_WEIGHT;
      // A surrogate pair is one code point.
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) size = 2;
      }
    }
    if (weight + w > limit) break;
    weight += w;
    i += size;
  }
  return { weight, end: i };
}

/**
 * Rough local token estimate for providers without a tokenizer endpoint.
 * ASCII runs at ~3.5 characters per token. Other scripts are denser: code points below
 * U+0800 (accented Latin, Greek, Cyrillic...) count as half a token each, and the rest
 * (CJK, kana, Hangul, emoji...) as a token each. A surrogate pair counts once.
 */
export function estimateTokens(text: string): number {
  if (!NON_ASCII.test(text)) return Math.ceil(text.length / ASCII_PER_TOKEN);
  // Same weights as `scan`, without its per-character limit check (this runs on whole diffs).
  let narrow = 0;
  let wide = 0;
  let lowHalves = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) {
      narrow++;
      continue;
    }
    wide++;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        lowHalves++;
        i++;
      }
    }
  }
  const ascii = text.length - narrow - wide - lowHalves;
  return Math.ceil((ascii + narrow * NARROW_WEIGHT + wide * WIDE_WEIGHT) / ASCII_PER_TOKEN);
}

/** The longest prefix of `text` that {@link estimateTokens} puts at `maxTokens` or fewer. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!(maxTokens > 0)) return '';
  const limit = maxTokens * ASCII_PER_TOKEN;
  if (!NON_ASCII.test(text)) return text.slice(0, Math.floor(limit));
  return text.slice(0, scan(text, limit).end);
}
