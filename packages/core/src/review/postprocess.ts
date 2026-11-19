import type { ReviewConfig } from '../config/schema';
import type { Logger } from '../logger';
import { toProviderError } from '../provider/errors';
import type { LLMProvider, ModelInfo } from '../provider/types';
import { addUsage } from '../provider/usage';
import { normalizeWhitespace } from './anchor';
import { createSnapshot, type IncrementalPlan } from './incremental';
import type { PreparedDiff } from './prepare';
import { summarizeReview } from './summarize';
import type { DropReason, Finding, RawFinding, ReviewResult } from './types';
import { validateFindings } from './validate';
import { verifyFindings } from './verify';

interface ModelCall {
  provider: LLMProvider;
  model: ModelInfo;
  config: ReviewConfig;
  signal: AbortSignal;
  logger: Logger;
}

/**
 * Validates the parts' findings against what was sent and, with `verify`, drops those a
 * second request rejects. Sets `result.findings` (and `verify`, usage, errors,
 * `cancelled`); returns the dropped counts so far.
 */
export async function checkFindings(
  raw: RawFinding[],
  invalid: number,
  options: ModelCall & {
    diff: PreparedDiff;
    result: ReviewResult;
    /** Verify pass with this model (`undefined`: none). */
    verifyModel?: ModelInfo;
    concurrency: number;
    /** The caller's signal: aborted means cancelled. */
    cancelSignal?: AbortSignal;
    onVerify?: () => void;
  },
): Promise<Map<DropReason, number>> {
  const { diff, result, config, logger } = options;
  const originals = new Map(diff.review.files.map((f) => [f.path, f]));
  const validated = validateFindings(raw, { config, files: diff.review.redacted, originals });
  result.findings = validated.findings;
  const dropped = new Map<DropReason, number>(validated.dropped);
  if (invalid) dropped.set('invalid', (dropped.get('invalid') ?? 0) + invalid);

  if (options.verifyModel && !result.cancelled && result.findings.length) {
    options.onVerify?.();
    const checked = await verifyFindings({
      provider: options.provider,
      model: options.verifyModel,
      config,
      files: diff.review.redacted,
      findings: result.findings,
      signal: options.signal,
      concurrency: options.concurrency,
      logger,
    });
    result.usage = addUsage(result.usage, checked.usage);
    result.verify = {
      checked: checked.checked,
      rejected: checked.rejected.length,
      failed: checked.failed,
    };
    const unchecked = result.findings.length - checked.checked;
    result.findings = checked.findings;
    if (checked.rejected.length) dropped.set('rejectedByVerify', checked.rejected.length);
    if (checked.failed) {
      result.errors.push(
        `Verify: ${checked.failed} request(s) failed or were not sent; ${unchecked} finding(s) are shown unchecked.`,
      );
    }
    result.cancelled = !!options.cancelSignal?.aborted;
    logger.info(
      `verify pass: ${checked.rejected.length} of ${result.verify.checked} finding(s) rejected`,
    );
  }
  return dropped;
}

/**
 * Adds the findings carried over from the previous review, sorted with the new ones, and
 * sets `result.incremental`.
 */
export function mergeCarried(result: ReviewResult, plan: IncrementalPlan): void {
  // A new finding with the same fingerprint replaces the carried one, unless its real
  // code differs (two secrets that look the same once redacted).
  const sameKey = (f: Finding) => `${f.id}\n${normalizeWhitespace(f.quote)}`;
  const ids = new Set(result.findings.map(sameKey));
  const carried = plan.carried.filter((f) => !ids.has(sameKey(f)));
  result.findings = [...result.findings, ...carried].sort(
    (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  result.incremental = {
    newHunks: plan.newHunks,
    reusedHunks: plan.reusedHunks,
    carried: carried.length,
  };
}

/**
 * The walkthrough + top risks of the whole change (`result.summary`): the previous one when
 * nothing new was reviewed, else one more request. A failed summary is only an error.
 */
export async function addSummary(
  options: ModelCall & {
    diff: PreparedDiff;
    result: ReviewResult;
    /** Parts sent in this review. */
    parts: number;
    onSummary?: () => void;
  },
): Promise<void> {
  const { diff, result, parts, logger } = options;
  const { plan } = diff;
  if (plan && parts === 0 && diff.previous?.summary) {
    // Nothing new was reviewed: the last summary still describes these changes.
    result.summary = diff.previous.summary;
    return;
  }
  if (
    result.cancelled ||
    // Nothing new but no earlier summary (summary just turned on): write one now.
    !(result.chunks.completed > 0 || (plan && parts === 0 && diff.files.length > 0))
  ) {
    return;
  }
  options.onSummary?.();
  try {
    const summary = await summarizeReview({
      provider: options.provider,
      model: options.model,
      config: options.config,
      // Incremental: summarize the whole change, not just the new hunks.
      files: diff.redacted,
      skipped: result.skipped,
      findings: result.findings,
      signal: options.signal,
      logger,
    });
    result.usage = addUsage(result.usage, summary.usage);
    // Cancelling here only loses the summary: the findings are complete.
    if (summary.text) result.summary = summary.text;
  } catch (err) {
    // A missing summary must not lose the findings.
    const error = toProviderError(err);
    logger.warn(`summary failed: ${error.message}`);
    result.errors.push(`Summary: ${error.message}`);
  }
}

/** Sets `result.snapshot` when the next review may build on this one. */
export function addSnapshot(result: ReviewResult, diff: PreparedDiff): void {
  // Only a complete review may be built on: otherwise the next one starts over. A part
  // with only some valid findings, or findings verify could not check, is not complete.
  if (
    !result.cancelled &&
    result.chunks.failed === 0 &&
    !result.chunks.outcomes.includes('partial') &&
    !result.verify?.failed
  ) {
    result.snapshot = createSnapshot(diff.key, diff.redacted, result.findings, result.summary);
  }
}
