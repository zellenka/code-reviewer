import { createHash } from 'node:crypto';
import { severityRank, type ReviewConfig } from '../config/schema';
import { normalizeEol, splitLines, toPosixPath } from '../diff/parse';
import type { FileDiff } from '../diff/types';
import { locateQuote, normalizeWhitespace } from './anchor';
import { REDACTED_MARK } from './redact';
import type { DropReason, Finding, RawFinding } from './types';

/** sha1(file + "\n" + category + "\n" + normalize(quote)). Title is not part of it. */
export function fingerprint(file: string, category: string, quote: string): string {
  return createHash('sha1')
    .update(`${file}\n${category}\n${normalizeWhitespace(quote)}`)
    .digest('hex');
}

interface FileContext {
  file: FileDiff;
  /** Index 0 = line 1. `undefined` where the content isn't known (no newContent). */
  lines: (string | undefined)[];
  /** Unredacted lines, for restoring quotes that contain redaction marks. */
  originalLines?: (string | undefined)[];
  changed: Set<number>;
  hunkRanges: { start: number; end: number }[];
}

export interface ValidateOptions {
  config: ReviewConfig;
  /** The files as sent to the model (possibly redacted). */
  files: FileDiff[];
  /** Same files before redaction, by path. */
  originals?: Map<string, FileDiff>;
}

export interface ValidateResult {
  findings: Finding[];
  dropped: Map<DropReason, number>;
}

/**
 * Turns raw model findings into displayable ones: resolves the file, re-anchors by
 * quote, applies thresholds/categories/changed-lines rules and removes duplicates.
 */
export function validateFindings(raw: RawFinding[], options: ValidateOptions): ValidateResult {
  const { config } = options;
  const dropped = new Map<DropReason, number>();
  const drop = (reason: DropReason) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
  const contexts = new Map(
    options.files.map((f) => [f.path, buildContext(f, options.originals?.get(f.path))]),
  );
  const minSeverity = severityRank(config.severityThreshold);
  const categories = new Set(config.review.categories);

  const kept: Finding[] = [];
  for (const r of raw) {
    const ctx = resolveFile(r.file, contexts);
    if (!ctx) {
      drop('unknownFile');
      continue;
    }
    if (!categories.has(r.category)) {
      drop('categoryDisabled');
      continue;
    }
    if (severityRank(r.severity) < minSeverity) {
      drop('belowSeverity');
      continue;
    }
    if (r.confidence < config.confidenceThreshold) {
      drop('lowConfidence');
      continue;
    }

    const path = ctx.file.path;
    let startLine: number;
    let endLine: number;
    let anchor: Finding['anchor'] = 'line';
    let quote = r.quote;

    if (r.anchor === 'file') {
      anchor = 'file';
      startLine = endLine = 1;
    } else {
      const match = locateQuote(ctx.lines, r.quote, {
        nearLine: r.startLine,
        fuzzyRanges: ctx.hunkRanges,
        prefer: (start, end) => intersects(ctx.changed, start, end),
      });
      if (!match) {
        drop('unanchored');
        continue;
      }
      startLine = match.startLine;
      endLine = match.endLine;
      if (match.method === 'fuzzy') quote = linesText(ctx.lines, startLine, endLine);
      if (config.onlyChangedLines && !intersects(ctx.changed, startLine, endLine)) {
        drop('outsideChangedLines');
        continue;
      }
    }

    // Quotes with redaction marks would never match the real file: use the real lines.
    let suggestion = r.suggestion;
    if (quote.includes(REDACTED_MARK) && ctx.originalLines && anchor === 'line') {
      quote = linesText(ctx.originalLines, startLine, endLine);
    }
    if (suggestion?.includes(REDACTED_MARK)) suggestion = undefined;

    const finding: Finding = {
      id: fingerprint(path, r.category, quote),
      file: path,
      startLine,
      endLine,
      anchor,
      severity: r.severity,
      category: r.category,
      title: r.title,
      body: r.body,
      quote,
      confidence: r.confidence,
    };
    if (suggestion !== undefined && anchor === 'line') finding.suggestion = suggestion;
    kept.push(finding);
  }

  const findings = dedupe(kept, () => drop('duplicate'));
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  return { findings, dropped };
}

/** Same file + category + overlapping range (or same id) → keep the more severe / confident one. */
function dedupe(findings: Finding[], onDrop: () => void): Finding[] {
  const ordered = [...findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence,
  );
  const out: Finding[] = [];
  for (const f of ordered) {
    const dup = out.some(
      (o) =>
        o.id === f.id ||
        (o.file === f.file &&
          o.category === f.category &&
          o.anchor === 'line' &&
          f.anchor === 'line' &&
          o.startLine <= f.endLine &&
          f.startLine <= o.endLine),
    );
    if (dup) onDrop();
    else out.push(f);
  }
  return out;
}

function buildContext(file: FileDiff, original?: FileDiff): FileContext {
  const changed = new Set<number>();
  const hunkRanges: FileContext['hunkRanges'] = [];
  for (const hunk of file.hunks) {
    hunkRanges.push({
      start: hunk.newStart - 3,
      end: hunk.newStart + Math.max(hunk.newLines, 1) + 3,
    });
    hunk.lines.forEach((line, i) => {
      if (line.kind === 'add' && line.newLine !== undefined) changed.add(line.newLine);
      if (line.kind === 'del') {
        // Deleted code is reported on the nearest new-side line, so those count as changed.
        const before = findNewLine(hunk.lines, i, -1);
        const after = findNewLine(hunk.lines, i, 1);
        if (before !== undefined) changed.add(before);
        if (after !== undefined) changed.add(after);
      }
    });
  }
  const ctx: FileContext = { file, lines: newSideLines(file), changed, hunkRanges };
  if (original) ctx.originalLines = newSideLines(original);
  return ctx;
}

function findNewLine(lines: FileDiff['hunks'][number]['lines'], from: number, step: 1 | -1) {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    const n = lines[i]!.newLine;
    if (n !== undefined) return n;
  }
  return undefined;
}

/** New-side lines (index 0 = line 1); `undefined` where only the hunks are known. */
export function newSideLines(file: FileDiff): (string | undefined)[] {
  if (file.newContent !== undefined) return splitLines(normalizeEol(file.newContent));
  const lines: (string | undefined)[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) lines[line.newLine - 1] = line.text;
    }
  }
  return Array.from(lines, (l) => l);
}

function linesText(lines: (string | undefined)[], start: number, end: number): string {
  return lines
    .slice(start - 1, end)
    .map((l) => l ?? '')
    .join('\n');
}

function intersects(changed: Set<number>, start: number, end: number): boolean {
  for (let n = start; n <= end; n++) if (changed.has(n)) return true;
  return false;
}

function resolveFile(
  reported: string,
  contexts: Map<string, FileContext>,
): FileContext | undefined {
  const path = toPosixPath(reported.trim())
    .replace(/^(?:a|b)\//, '')
    .replace(/^\/+/, '');
  const direct = contexts.get(path) ?? contexts.get(reported);
  if (direct) return direct;
  const lower = path.toLowerCase();
  const matches = [...contexts.values()].filter((c) => {
    const p = c.file.path.toLowerCase();
    return p === lower || p.endsWith(`/${lower}`) || lower.endsWith(`/${p}`);
  });
  return matches.length === 1 ? matches[0] : undefined;
}
