import { splitLines } from '../diff/parse';
import type { FileDiff, Hunk } from '../diff/types';
import { estimateTokens } from '../provider/usage';
import { enclosingSymbols, heuristicSymbols, type CodeSymbol, type SymbolIndex } from './symbols';

/** Unchanged new-side lines shown next to a file's hunks. */
export interface ContextRange {
  /** 1-based line of `lines[0]`. */
  startLine: number;
  lines: string[];
}

export interface ContextOptions {
  /** Language-server symbols per path; others use `heuristicSymbols`. */
  symbols?: SymbolIndex;
  /** Lines around a change when no enclosing symbol is found (or it's too big). Default 15. */
  surroundingLines?: number;
  /** An enclosing function/class up to this many lines is shown whole. Default 200. */
  maxSymbolLines?: number;
  /** Token budget for one file part's context. Default 3000. */
  maxTokens?: number;
}

/**
 * Picks the unchanged code that helps review `hunks`: the whole innermost enclosing
 * function/method (when it fits), the header lines of every outer symbol (class, namespace),
 * and otherwise a few surrounding lines. Lines already in the hunks are left out.
 * Needs `file.newContent`; returns [] without it.
 */
export function buildFileContext(
  file: FileDiff,
  hunks: readonly Hunk[],
  symbols: readonly CodeSymbol[] | undefined,
  options: ContextOptions = {},
): ContextRange[] {
  if (file.newContent === undefined || !hunks.length) return [];
  const content = splitLines(file.newContent);
  const surrounding = options.surroundingLines ?? 15;
  const maxSymbolLines = options.maxSymbolLines ?? 200;
  const maxTokens = options.maxTokens ?? 3_000;

  const shown = new Set<number>();
  for (const h of hunks) for (const l of h.lines) if (l.newLine !== undefined) shown.add(l.newLine);

  // Lines that changed, or (for pure deletions) the new-side line where code was removed.
  const changed = new Set<number>();
  for (const h of hunks) {
    let sawAdd = false;
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine !== undefined) {
        changed.add(l.newLine);
        sawAdd = true;
      }
    }
    if (!sawAdd) changed.add(Math.max(1, h.newStart));
  }

  const tree = symbols ?? heuristicSymbols(file.newContent);
  const headers = new Set<number>();
  const bodies = new Map<string, CodeSymbol>();
  const fallback: number[] = [];
  for (const line of changed) {
    const chain = enclosingSymbols(tree, line);
    const inner = chain.at(-1);
    for (const outer of chain.slice(0, inner && fits(inner) ? -1 : undefined)) {
      for (const l of headerLines(outer, content)) headers.add(l);
    }
    if (inner && fits(inner)) bodies.set(`${inner.startLine}:${inner.endLine}`, inner);
    else fallback.push(line);
  }
  function fits(s: CodeSymbol): boolean {
    return s.endLine - s.startLine + 1 <= maxSymbolLines;
  }

  const picked = new Set<number>();
  let tokens = 0;
  const add = (lines: Iterable<number>): boolean => {
    const fresh = [...lines].filter(
      (l) => l >= 1 && l <= content.length && !shown.has(l) && !picked.has(l),
    );
    const cost = fresh.reduce((n, l) => n + estimateTokens(content[l - 1]!) + 3, 0);
    if (tokens + cost > maxTokens) return false;
    for (const l of fresh) picked.add(l);
    tokens += cost;
    return true;
  };

  add(headers);
  // Smaller bodies first, so one huge function doesn't crowd out the others.
  const sortedBodies = [...bodies.values()].sort(
    (a, b) => a.endLine - a.startLine - (b.endLine - b.startLine),
  );
  for (const s of sortedBodies) {
    if (!add(range(s.startLine, s.endLine))) {
      add(headerLines(s, content));
      fallback.push(...[...changed].filter((l) => s.startLine <= l && l <= s.endLine));
    }
  }
  for (const line of fallback) {
    add(range(line - surrounding, line + surrounding));
  }

  return toRanges(
    [...picked].sort((a, b) => a - b),
    content,
  );
}

/** The declaration line, plus following lines up to the one that opens the block (≤ 4). */
function headerLines(symbol: CodeSymbol, content: string[]): number[] {
  const out: number[] = [];
  for (let l = symbol.startLine; l <= Math.min(symbol.endLine, symbol.startLine + 3); l++) {
    out.push(l);
    if (/[{:]\s*$|=>\s*$/.test(content[l - 1] ?? '')) break;
  }
  return out;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let l = start; l <= end; l++) out.push(l);
  return out;
}

function toRanges(lines: number[], content: string[]): ContextRange[] {
  const ranges: ContextRange[] = [];
  for (const l of lines) {
    const last = ranges.at(-1);
    if (last && last.startLine + last.lines.length === l) last.lines.push(content[l - 1]!);
    else ranges.push({ startLine: l, lines: [content[l - 1]!] });
  }
  return ranges;
}

/**
 *     <context path="src/a.ts">
 *          3   export class Foo {
 *        ...
 *         10     bar() {
 *     </context>
 */
export function renderContext(path: string, ranges: readonly ContextRange[]): string {
  if (!ranges.length) return '';
  const out = [`<context path="${escapeAttr(path)}">`];
  ranges.forEach((r, i) => {
    if (i > 0) out.push('   ...');
    r.lines.forEach((text, j) => out.push(`${String(r.startLine + j).padStart(6)}   ${text}`));
  });
  out.push('</context>');
  return out.join('\n');
}

export interface ChangedSymbol {
  path: string;
  /** Outer-to-inner names, e.g. ['Cart', 'total']. */
  names: string[];
  kind: string;
  startLine: number;
  endLine: number;
  /** First line of the declaration, trimmed. */
  signature: string;
}

/** The innermost symbol around each changed line of each file, deduplicated. */
export function changedSymbols(files: readonly FileDiff[], symbols?: SymbolIndex): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  for (const file of files) {
    if (file.newContent === undefined) continue;
    const content = splitLines(file.newContent);
    const tree = symbols?.get(file.path) ?? heuristicSymbols(file.newContent);
    const seen = new Set<CodeSymbol>();
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.kind !== 'add' || l.newLine === undefined) continue;
        const chain = enclosingSymbols(tree, l.newLine);
        const inner = chain.at(-1);
        if (!inner || seen.has(inner)) continue;
        seen.add(inner);
        out.push({
          path: file.path,
          names: chain.map((s) => s.name),
          kind: inner.kind,
          startLine: inner.startLine,
          endLine: inner.endLine,
          signature: (content[inner.startLine - 1] ?? '').trim().slice(0, 160),
        });
      }
    }
  }
  return out;
}

/**
 * The "changed symbols across this diff" block sent with every part of a review, so a
 * part can notice that it calls a function another part changed. Undefined for a single
 * file (nothing to cross-reference).
 */
export function renderChangedSymbols(
  list: readonly ChangedSymbol[],
  options: { maxEntries?: number } = {},
): string | undefined {
  if (new Set(list.map((s) => s.path)).size < 2) return undefined;
  const max = options.maxEntries ?? 60;
  const lines = list
    .slice(0, max)
    .map(
      (s) =>
        `- ${s.path}:${s.startLine}-${s.endLine} ${s.kind} ${s.names.join('.')}: \`${s.signature.replace(/`/g, "'")}\``,
    );
  if (list.length > max) lines.push(`- … and ${list.length - max} more`);
  return `<changed_symbols>
Declarations changed anywhere in this change (all files, not only the ones below). Use them to spot callers or callees that no longer match:
${lines.join('\n')}
</changed_symbols>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
