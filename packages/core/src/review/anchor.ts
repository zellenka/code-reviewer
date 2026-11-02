import { normalizeEol, splitLines } from '../diff/parse';

export interface QuoteMatch {
  startLine: number;
  endLine: number;
  method: 'exact' | 'normalized' | 'fuzzy';
  /** The quote lines that matched (after stripping copied line numbers or +/- markers). */
  quoteLines: string[];
}

export interface LocateOptions {
  /** Reported line; among several matches the nearest one wins. */
  nearLine?: number;
  /** Among several exact/normalized matches, prefer ones where this is true (e.g. changed lines). */
  prefer?: (startLine: number, endLine: number) => boolean;
  /**
   * Only matches fully inside this range (1-based, inclusive) count, in every step.
   * Use it when the code is known to be near a line, so an identical line elsewhere
   * in the file isn't picked up. Default: whole file.
   */
  searchRange?: { start: number; end: number };
  /** Line ranges searched by the fuzzy step (clipped to `searchRange`). Default: whole file. */
  fuzzyRanges?: { start: number; end: number }[];
  /** Minimum similarity for a fuzzy match. Default 0.8. */
  fuzzyThreshold?: number;
}

/** Collapses runs of whitespace and trims. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Finds `quote` in `lines` (index 0 = line 1; `undefined` = unknown line).
 * Tries exact → whitespace-normalized → fuzzy, and also variants without
 * line-number prefixes or +/- markers the model may have copied from the prompt.
 */
export function locateQuote(
  lines: readonly (string | undefined)[],
  quote: string,
  options: LocateOptions = {},
): QuoteMatch | undefined {
  const base = trimBlankLines(splitLines(normalizeEol(quote)));
  if (!base.length || base.every((l) => !l.trim())) return undefined;

  const variants = [base];
  const numbered = /^\s*\d+\s+[+\- ]\s/;
  if (base.every((l) => numbered.test(l))) variants.push(base.map((l) => l.replace(numbered, '')));
  if (base.every((l) => /^[+\- ]/.test(l))) variants.push(base.map((l) => l.slice(1)));

  for (const method of ['exact', 'normalized'] as const) {
    for (const variant of variants) {
      const hits = findAll(lines, variant, method === 'normalized').filter((h) =>
        inRange(h, h + variant.length - 1, options.searchRange),
      );
      if (hits.length) {
        const preferred = options.prefer
          ? hits.filter((h) => options.prefer!(h, h + variant.length - 1))
          : [];
        const start = nearest(preferred.length ? preferred : hits, options.nearLine);
        return {
          startLine: start,
          endLine: start + variant.length - 1,
          method,
          quoteLines: variant,
        };
      }
    }
  }
  const fuzzy = fuzzyFind(lines, base, options);
  return fuzzy ? { ...fuzzy, method: 'fuzzy', quoteLines: base } : undefined;
}

function inRange(start: number, end: number, range: LocateOptions['searchRange']): boolean {
  return !range || (start >= range.start && end <= range.end);
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end);
}

/**
 * Start lines where the quote matches. Single line: substring of a line.
 * Multi-line: first line is a suffix, middle lines equal, last line a prefix.
 */
function findAll(
  lines: readonly (string | undefined)[],
  quote: string[],
  normalized: boolean,
): number[] {
  const norm = (s: string) => (normalized ? normalizeWhitespace(s) : s);
  const q = quote.map(norm);
  const hits: number[] = [];
  for (let i = 0; i + q.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length && ok; j++) {
      const raw = lines[i + j];
      if (raw === undefined) {
        ok = false;
        break;
      }
      const line = norm(raw);
      const part = q[j]!;
      if (q.length === 1) ok = line.includes(part);
      else if (j === 0) ok = line.endsWith(part);
      else if (j === q.length - 1) ok = line.startsWith(part);
      else ok = line === part;
    }
    if (ok) hits.push(i + 1);
  }
  return hits;
}

function nearest(starts: number[], near: number | undefined): number {
  if (near === undefined) return starts[0]!;
  return starts.reduce((best, s) => (Math.abs(s - near) < Math.abs(best - near) ? s : best));
}

function fuzzyFind(
  lines: readonly (string | undefined)[],
  quote: string[],
  options: LocateOptions,
): { startLine: number; endLine: number } | undefined {
  const threshold = options.fuzzyThreshold ?? 0.8;
  const limit = options.searchRange;
  const ranges = (options.fuzzyRanges ?? [{ start: 1, end: lines.length }]).map((r) =>
    limit ? { start: Math.max(r.start, limit.start), end: Math.min(r.end, limit.end) } : r,
  );
  const q = quote.map(normalizeWhitespace);
  let best: { start: number; score: number } | undefined;
  for (const range of ranges) {
    const from = Math.max(1, range.start);
    const to = Math.min(lines.length, range.end) - q.length + 1;
    for (let start = from; start <= to; start++) {
      let total = 0;
      let complete = true;
      for (let j = 0; j < q.length; j++) {
        const line = lines[start - 1 + j];
        if (line === undefined) {
          complete = false;
          break;
        }
        total += similarity(normalizeWhitespace(line), q[j]!);
      }
      if (!complete) continue;
      const score = total / q.length;
      const better =
        !best ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) < 1e-9 &&
          options.nearLine !== undefined &&
          Math.abs(start - options.nearLine) < Math.abs(best.start - options.nearLine));
      if (better) best = { start, score };
    }
  }
  if (!best || best.score < threshold) return undefined;
  return { startLine: best.start, endLine: best.start + q.length - 1 };
}

/** Sørensen–Dice coefficient on character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = bigrams.get(g) ?? 0;
    if (n > 0) {
      bigrams.set(g, n - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}
