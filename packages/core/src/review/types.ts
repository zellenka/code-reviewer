import type { Category, Severity } from '../config/schema';
import type { Usage } from '../provider/types';

export interface Finding {
  /** Fingerprint: sha1(file + "\n" + category + "\n" + normalize(quote)). */
  id: string;
  file: string;
  /** 1-based, inclusive, new side. */
  startLine: number;
  endLine: number;
  /** 'file' = whole-file finding (e.g. missing tests), shown at line 1. */
  anchor: 'line' | 'file';
  severity: Severity;
  category: Category;
  title: string;
  /** Markdown. */
  body: string;
  /** Exact new-side code the finding refers to; may be multi-line. */
  quote: string;
  /** Replacement code for `quote`. */
  suggestion?: string;
  /** 0..1 */
  confidence: number;
  /** Set by the host when `quote` is no longer found in the working tree. */
  stale?: boolean;
}

/** A finding as the model reported it, after schema validation but before re-anchoring. */
export interface RawFinding {
  file: string;
  startLine: number;
  endLine: number;
  anchor?: 'line' | 'file';
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  quote: string;
  suggestion?: string;
  confidence: number;
}

export type DropReason =
  | 'invalid'
  | 'unknownFile'
  | 'categoryDisabled'
  | 'belowSeverity'
  | 'lowConfidence'
  | 'unanchored'
  | 'outsideChangedLines'
  | 'duplicate';

export const DROP_REASON_LABELS: Record<DropReason, string> = {
  invalid: 'invalid model output',
  unknownFile: 'file not in the diff',
  categoryDisabled: 'category turned off',
  belowSeverity: 'below the severity threshold',
  lowConfidence: 'below the confidence threshold',
  unanchored: 'quoted code not found',
  outsideChangedLines: 'outside changed lines',
  duplicate: 'duplicate',
};

export type SkipReason =
  | 'deleted'
  | 'binary'
  | 'secret'
  | 'lockfile'
  | 'buildOutput'
  | 'minified'
  | 'snapshot'
  | 'generated'
  | 'configIgnore'
  | 'noChanges';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

/** How the model's structured output was obtained for one chunk. */
export type ParseOutcome = 'valid' | 'repaired' | 'partial' | 'failed' | 'cancelled';

export interface ReviewResult {
  findings: Finding[];
  summary?: string;
  usage: Usage;
  dropped: { reason: DropReason; count: number }[];
  /** Files in the diff that were not sent to the model. Deleted files are listed here too. */
  skipped: SkippedFile[];
  /** Files that were reviewed. */
  reviewedFiles: string[];
  chunks: { total: number; completed: number; failed: number; outcomes: ParseOutcome[] };
  cancelled: boolean;
  /** User-facing messages for chunks that failed (the rest of the review still ran). */
  errors: string[];
  /** Number of secrets replaced before sending. */
  redactions: number;
  /** How the review ran (agentic falls back to single-pass without repo access or tools). */
  mode: 'single-pass' | 'agentic';
  /** Repo rules files that were applied. */
  rules?: string[];
  /** Agentic reviews: totals over all parts. `limitStops` = parts stopped by a limit. */
  agent?: { turns: number; toolCalls: number; limitStops: number };
}
