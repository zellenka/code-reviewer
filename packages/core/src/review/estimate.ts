import type { UnifiedDiff } from '../diff/types';
import type { Usage } from '../provider/types';
import { estimateCostUsd, estimateTokens } from '../provider/usage';
import { renderChunk } from './chunker';
import type { ReviewSnapshot } from './incremental';
import { prepareParts, toPreparedDiff, type PreparedDiff, type PrepareOptions } from './prepare';
import { buildUserPrompt } from './prompt';
import { buildSummarySystemPrompt } from './summarize';
import { estimateVerify } from './verify';

/** Output tokens one review request typically uses: none found … many long findings. */
export const OUTPUT_TOKENS_PER_REQUEST = { low: 150, high: 2_000 } as const;
/** Extra output per agentic turn (tool calls) at the high end. */
export const OUTPUT_TOKENS_PER_AGENT_TURN = 400;
/** Output tokens of one verify request at the high end. */
export const VERIFY_OUTPUT_TOKENS_PER_REQUEST = 600;
/** Output tokens of the summary request. */
export const SUMMARY_OUTPUT_TOKENS = { low: 200, high: 800 } as const;

export interface ReviewEstimate {
  mode: 'single-pass' | 'agentic';
  /** Files that would be sent. */
  files: number;
  skipped: number;
  /** Model requests, without repair retries. Agentic: one per part (more turns may follow). */
  requests: number;
  /** Estimated input tokens (`estimateTokens`), without repair retries. Cached tokens included. */
  inputTokens: number;
  /** Agentic only: input tokens if every part uses its whole agent token budget. */
  inputTokensHigh?: number;
  outputTokens: { low: number; high: number };
  /** USD; only when the model has pricing. Prompt caching of the shared prefix is included. */
  costUsd?: { low: number; high: number };
  /**
   * Verify pass: at most one request per reviewed file, only for files with findings, so
   * it is counted in the high end of the cost only.
   */
  verify?: { maxRequests: number; maxInputTokens: number };
}

/**
 * Estimates what a review will send before running it: same filtering, context and
 * chunking as `runReview`, so the request count is exact for single-pass; tokens are
 * estimated. Agentic reviews get a range: one turn per part … the whole agent budget.
 * `diff` may be prepared already (`prepareDiff`, same options), to share it with the run.
 */
export function estimateReview(
  diff: UnifiedDiff | PreparedDiff,
  options: PrepareOptions & { summary?: boolean; verify?: boolean; previous?: ReviewSnapshot },
): ReviewEstimate {
  const { model, config } = options;
  const prepared = prepareParts(toPreparedDiff(diff, options), options);
  const parts = prepared.chunks.length;
  const shared = prepared.sharedPrefixTokens;
  const perPart = prepared.chunks.map((chunk) =>
    estimateTokens(buildUserPrompt(renderChunk(chunk))),
  );
  let inputTokens = perPart.reduce((sum, t) => sum + shared + t, 0);
  let requests = parts;
  const outputTokens = {
    low: parts * OUTPUT_TOKENS_PER_REQUEST.low,
    high: parts * OUTPUT_TOKENS_PER_REQUEST.high,
  };
  let inputTokensHigh: number | undefined;
  if (prepared.mode === 'agentic') {
    const limits = prepared.agentLimits;
    // The loop keeps room for the final turn and a repair inside the budget; a part whose
    // first request is already large still makes those (up to 3 requests of its size).
    inputTokensHigh = perPart.reduce(
      (sum, t) => sum + Math.max(3 * (shared + t), limits.tokenBudget),
      0,
    );
    outputTokens.high += parts * (limits.maxTurns + 1) * OUTPUT_TOKENS_PER_AGENT_TURN;
  }

  if (options.summary && requests > 0) {
    requests++;
    // The summary sends at most ~12k tokens of diff plus stats and findings.
    const diffTokens = Math.min(
      12_000,
      prepared.chunks.reduce((sum, c) => sum + c.tokens, 0),
    );
    const summaryTokens =
      estimateTokens(buildSummarySystemPrompt(config)) +
      diffTokens +
      prepared.redacted.files.length * 20 +
      200;
    inputTokens += summaryTokens;
    if (inputTokensHigh !== undefined) inputTokensHigh += summaryTokens;
    outputTokens.low += SUMMARY_OUTPUT_TOKENS.low;
    outputTokens.high += SUMMARY_OUTPUT_TOKENS.high;
  }
  const estimate: ReviewEstimate = {
    mode: prepared.mode,
    files: prepared.files.length,
    skipped: prepared.skipped.length,
    requests,
    inputTokens,
    outputTokens,
  };
  if (inputTokensHigh !== undefined) estimate.inputTokensHigh = inputTokensHigh;
  const verify =
    (options.verify ?? config.review.verify) && parts > 0
      ? estimateVerify(prepared.redacted.files, config)
      : undefined;
  if (verify) {
    estimate.verify = { maxRequests: verify.requests, maxInputTokens: verify.inputTokens };
  }
  if (model.pricing) {
    // With caching, the shared prefix is written once and read by the other parts.
    const cached =
      model.promptCaching && parts > 1 && shared >= model.promptCaching.minTokens ? shared : 0;
    const usage = (input: number, out: number): Usage => ({
      inputTokens: input - cached * parts,
      cacheWriteTokens: cached,
      cacheReadTokens: cached * (parts - 1),
      outputTokens: out,
      requests,
    });
    estimate.costUsd = {
      low: estimateCostUsd(usage(inputTokens, outputTokens.low), model.pricing),
      high:
        estimateCostUsd(usage(inputTokensHigh ?? inputTokens, outputTokens.high), model.pricing) +
        (verify
          ? estimateCostUsd(
              {
                inputTokens: verify.inputTokens,
                outputTokens: verify.requests * VERIFY_OUTPUT_TOKENS_PER_REQUEST,
                requests: verify.requests,
              },
              model.pricing,
            )
          : 0),
    };
  }
  return estimate;
}
