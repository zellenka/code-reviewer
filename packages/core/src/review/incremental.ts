import { createHash } from 'node:crypto';
import type { ReviewConfig } from '../config/schema';
import type { FileDiff, Hunk, UnifiedDiff } from '../diff/types';
import { locateQuote } from './anchor';
import type { RepoRules } from './rules';
import type { Finding } from './types';
import { newSideLines } from './validate';

/**
 * What a finished review remembers for the next one over the same scope (P5-4):
 * which hunks were reviewed and what was found. Kept by the host.
 */
export interface ReviewSnapshot {
  version: 1;
  /** Hash of everything besides the diff that changes what a review reports. */
  key: string;
  /** Hunk hashes per reviewed file. */
  hunks: Record<string, string[]>;
  findings: Finding[];
  /**
   * Per finding (same order): hash of the hunk it is in; `null` for whole-file findings
   * and findings outside a single hunk. A finding is only carried with its own hunk.
   */
  findingHunks: (string | null)[];
  summary?: string;
}

export interface IncrementalPlan {
  /** Only files with new hunks, and only those hunks. */
  diff: UnifiedDiff;
  /** Earlier findings whose code is in an unchanged hunk, placed on their current lines. */
  carried: Finding[];
  reusedHunks: number;
  newHunks: number;
}

/** A hunk's identity: its path and lines, without line numbers (edits above it don't change it). */
export function hunkHash(path: string, hunk: Hunk): string {
  const h = createHash('sha1').update(path);
  for (const line of hunk.lines) h.update(`\n${line.kind[0]}${line.text}`);
  return h.digest('hex');
}

/** Hashes the inputs besides the diff that change a review's outcome. */
export function snapshotKey(parts: {
  modelId: string;
  config: ReviewConfig;
  mode: 'single-pass' | 'agentic';
  context: boolean;
  rules?: RepoRules;
  verify?: boolean;
}): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        v: 1,
        model: parts.modelId,
        config: parts.config,
        mode: parts.mode,
        context: parts.context,
        verify: parts.verify ?? parts.config.review.verify,
        rules: parts.rules?.sources.map((s) => [s.path, s.text]) ?? [],
      }),
    )
    .digest('hex');
}

export function diffHunkHashes(files: readonly FileDiff[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of files) out[f.path] = f.hunks.map((h) => hunkHash(f.path, h));
  return out;
}

/** New-side line range of a hunk (a pure deletion covers the line after it). */
function hunkRange(h: Hunk): { start: number; end: number } {
  return { start: h.newStart, end: h.newStart + Math.max(h.newLines, 1) - 1 };
}

/** What the next review of the same scope builds on. `files` = the whole reviewed diff. */
export function createSnapshot(
  key: string,
  files: readonly FileDiff[],
  findings: readonly Finding[],
  summary?: string,
): ReviewSnapshot {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findingHunks = findings.map((f) => {
    const file = byPath.get(f.file);
    if (!file || f.anchor === 'file') return null;
    const hits = file.hunks.filter((h) => {
      const r = hunkRange(h);
      return f.startLine <= r.end && r.start <= f.endLine;
    });
    return hits.length === 1 ? hunkHash(file.path, hits[0]!) : null;
  });
  return {
    version: 1,
    key,
    hunks: diffHunkHashes(files),
    findings: [...findings],
    findingHunks,
    ...(summary ? { summary } : {}),
  };
}

/**
 * Splits a diff into what still needs a review and what was reviewed before.
 * A previous finding is carried over only with its own hunk: when that hunk is
 * unchanged and the quote is found in it (exactly or up to whitespace). Whole-file
 * findings are carried when nothing in the file changed.
 */
export function planIncremental(diff: UnifiedDiff, previous: ReviewSnapshot): IncrementalPlan {
  const files: FileDiff[] = [];
  const carried: Finding[] = [];
  let reusedHunks = 0;
  let newHunks = 0;
  const byFile = new Map<string, { finding: Finding; hunk: string | null }[]>();
  previous.findings.forEach((finding, i) => {
    const list = byFile.get(finding.file) ?? [];
    list.push({ finding, hunk: previous.findingHunks?.[i] ?? null });
    byFile.set(finding.file, list);
  });

  for (const file of diff.files) {
    const known = new Set(previous.hunks[file.path] ?? []);
    const reused: { hunk: Hunk; hash: string }[] = [];
    const fresh: Hunk[] = [];
    for (const hunk of file.hunks) {
      const hash = hunkHash(file.path, hunk);
      if (known.has(hash)) reused.push({ hunk, hash });
      else fresh.push(hunk);
    }
    reusedHunks += reused.length;
    newHunks += fresh.length;
    // Files without hunks (binary, pure renames) are handed on unchanged.
    if (fresh.length || !file.hunks.length) files.push({ ...file, hunks: fresh });

    const findings = byFile.get(file.path);
    if (!findings?.length || !reused.length) continue;
    const lines = newSideLines(file);
    for (const { finding: f, hunk } of findings) {
      if (f.anchor === 'file') {
        if (!fresh.length) carried.push({ ...f });
        continue;
      }
      // Its own hunk, unchanged (identical hunks: the one nearest its old place).
      const own = reused
        .filter((r) => r.hash === hunk)
        .sort(
          (a, b) =>
            Math.abs(a.hunk.newStart - f.startLine) - Math.abs(b.hunk.newStart - f.startLine),
        )[0];
      if (!own) continue;
      const match = locateQuote(lines, f.quote, {
        nearLine: f.startLine,
        searchRange: hunkRange(own.hunk),
        fuzzyRanges: [],
      });
      if (!match || match.method === 'fuzzy') continue;
      carried.push({ ...f, startLine: match.startLine, endLine: match.endLine });
    }
  }
  return { diff: { files }, carried, reusedHunks, newHunks };
}
