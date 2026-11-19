import { createHash } from 'node:crypto';
import type { ReviewConfig } from '../config/schema';
import type { FileDiff, Hunk, UnifiedDiff } from '../diff/types';
import { locateQuote } from './anchor';
import { redactFiles, type RedactOptions } from './redact';
import type { RepoRules } from './rules';
import type { Finding } from './types';
import { newSideLines } from './validate';

/**
 * What a finished review remembers for the next one over the same scope (P5-4):
 * which hunks were reviewed and what was found. Kept by the host, so it holds no
 * secrets: hunks are hashed as redacted (as sent to the model), and a finding with a
 * `redactedQuote` has that as its `quote` too (the real lines come back when carried).
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
   * and findings outside a single hunk. A finding is only carried with its own hunk; a
   * `null` one only when nothing in its file changed.
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

/**
 * A hunk's identity: its path and lines, without line numbers (edits above it don't change
 * it). Pass the redacted hunk: the hash of a line with a short secret could be guessed back.
 */
export function hunkHash(path: string, hunk: Hunk): string {
  const h = createHash('sha1').update(path);
  for (const line of hunk.lines) h.update(`\n${line.kind[0]}${line.text}`);
  return h.digest('hex');
}

/**
 * Version of the review pipeline in snapshot keys. Bump it when a change besides the
 * prompts (parsing, validation, chunking) changes what a review reports, so findings
 * of an older version are not carried over as if this one had found them.
 */
export const SNAPSHOT_PIPELINE_VERSION = 2;

/** Hashes the inputs besides the diff that change a review's outcome. */
export function snapshotKey(parts: {
  modelId: string;
  config: ReviewConfig;
  mode: 'single-pass' | 'agentic';
  context: boolean;
  rules?: RepoRules;
  verify?: boolean;
  redactHighEntropy?: boolean;
  /** System prompts as sent (review, verify): an update that changes them starts over. */
  prompts: string[];
}): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        v: SNAPSHOT_PIPELINE_VERSION,
        model: parts.modelId,
        config: parts.config,
        mode: parts.mode,
        context: parts.context,
        verify: parts.verify ?? parts.config.review.verify,
        rules: parts.rules?.sources.map((s) => [s.path, s.text]) ?? [],
        redactHighEntropy: parts.redactHighEntropy ?? false,
        prompts: parts.prompts,
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

/**
 * What the next review of the same scope builds on. `files` = the whole reviewed diff,
 * redacted (as sent to the model).
 */
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
    // Only the redacted lines are stored; `planIncremental` restores the real ones.
    findings: findings.map((f) =>
      f.redactedQuote === undefined ? { ...f } : { ...f, quote: f.redactedQuote },
    ),
    findingHunks,
    ...(summary ? { summary } : {}),
  };
}

/**
 * Splits a diff into what still needs a review and what was reviewed before.
 * A previous finding is carried over only with its own hunk: when that hunk is
 * unchanged and the quote is found in it (exactly or up to whitespace). Whole-file
 * findings are carried when nothing in the file changed, and so are findings outside
 * a single hunk (outside every hunk or across several) whose quote is still found.
 * Hunks are compared redacted with `redact` (as `createSnapshot` stored them), or as
 * given in `redact.redacted` (`diff.files` redacted, same order) when the caller has
 * them already; a finding stored with its redacted quote gets the real lines back.
 */
export function planIncremental(
  diff: UnifiedDiff,
  previous: ReviewSnapshot,
  redact: RedactOptions | { redacted: readonly FileDiff[] } = {},
): IncrementalPlan {
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

  const redacted = 'redacted' in redact ? redact.redacted : redactFiles(diff.files, redact).files;
  for (const [fileIndex, file] of diff.files.entries()) {
    const safe = redacted[fileIndex]!;
    const known = new Set(previous.hunks[file.path] ?? []);
    const reused: { hunk: Hunk; hash: string }[] = [];
    const fresh: Hunk[] = [];
    for (const [i, hunk] of file.hunks.entries()) {
      const hash = hunkHash(file.path, safe.hunks[i]!);
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
    const safeLines = newSideLines(safe);
    for (const { finding: f, hunk } of findings) {
      if (f.anchor === 'file') {
        if (!fresh.length) carried.push({ ...f });
        continue;
      }
      let searchRange: { start: number; end: number } | undefined;
      if (hunk === null) {
        // Outside every hunk or across several: like a whole-file finding, carried only
        // when nothing in the file changed (and its quote is still there).
        if (fresh.length) continue;
      } else {
        // Its own hunk, unchanged (identical hunks: the one nearest its old place).
        const own = reused
          .filter((r) => r.hash === hunk)
          .sort(
            (a, b) =>
              Math.abs(a.hunk.newStart - f.startLine) - Math.abs(b.hunk.newStart - f.startLine),
          )[0];
        if (!own) continue;
        searchRange = hunkRange(own.hunk);
      }
      const match = locateQuote(
        f.redactedQuote === undefined ? lines : safeLines,
        f.redactedQuote ?? f.quote,
        {
          nearLine: f.startLine,
          ...(searchRange ? { searchRange } : {}),
          fuzzyRanges: [],
        },
      );
      if (!match || match.method === 'fuzzy') continue;
      const { startLine, endLine } = match;
      if (f.redactedQuote === undefined) carried.push({ ...f, startLine, endLine });
      else {
        // Stored redacted: the real code of the same lines (as `validateFindings` does).
        const quote = lines
          .slice(startLine - 1, endLine)
          .map((l) => l ?? '')
          .join('\n');
        carried.push({ ...f, startLine, endLine, quote });
      }
    }
  }
  return { diff: { files }, carried, reusedHunks, newHunks };
}
