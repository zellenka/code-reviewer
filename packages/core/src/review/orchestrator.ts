import type { ReviewConfig } from '../config/schema';
import type { FileDiff, UnifiedDiff } from '../diff/types';
import { noopLogger, type Logger } from '../logger';
import { isProviderError, toProviderError } from '../provider/errors';
import type { LLMProvider, ModelInfo } from '../provider/types';
import { addUsage, emptyUsage, estimateCostUsd, estimateTokens } from '../provider/usage';
import { chunkFiles, renderChunk, type Chunk } from './chunker';
import { filterFiles } from './filter';
import { buildSystemPrompt, buildUserPrompt } from './prompt';
import { REPORT_FINDINGS_TOOL } from './output';
import { redactFiles } from './redact';
import { reviewChunk } from './reviewer';
import { buildSummarySystemPrompt, summarizeReview } from './summarize';
import type { DropReason, RawFinding, ReviewResult, SkippedFile } from './types';
import { validateFindings } from './validate';

export interface ReviewProgress {
  chunksTotal: number;
  chunksDone: number;
  findings: number;
  /** 'summary' while the summary request runs. */
  phase?: 'review' | 'summary';
}

export interface ReviewOptions {
  provider: LLMProvider;
  model: ModelInfo;
  config: ReviewConfig;
  /** Parallel requests. Default: 2 for Copilot, 4 for Anthropic, else 2. */
  concurrency?: number;
  signal?: AbortSignal;
  logger?: Logger;
  onProgress?: (progress: ReviewProgress) => void;
  /** Also redact high-entropy strings (known secret formats are always redacted). */
  redactHighEntropy?: boolean;
  /** Upper bound for one chunk, whatever the model allows. Default 24k tokens. */
  maxChunkTokens?: number;
  /** Max number of requests (chunks) per review. Default 40. */
  maxChunks?: number;
  /** Output tokens per request. Default min(model max, 16k). */
  maxOutputTokens?: number;
  /** One extra request for a walkthrough + top risks (`ReviewResult.summary`). Default false. */
  summary?: boolean;
}

/** Errors that will fail every chunk the same way: stop the whole review. */
const FATAL_KINDS = new Set(['auth', 'consent', 'quota', 'notFound']);

export function defaultConcurrency(providerId: string): number {
  return providerId === 'anthropic' ? 4 : 2;
}

/**
 * Tokens one chunk may use: input limit − system prompt − tool schema − output reserve,
 * with a 20% margin because token counts are estimated.
 */
export function chunkBudget(
  model: ModelInfo,
  config: ReviewConfig,
  options: { maxChunkTokens?: number; maxOutputTokens?: number } = {},
): { chunkTokens: number; outputTokens: number } {
  const outputTokens = options.maxOutputTokens ?? Math.min(model.maxOutputTokens, 16_000);
  const fixed =
    estimateTokens(buildSystemPrompt({ config, jsonOnly: !model.supportsTools })) +
    estimateTokens(JSON.stringify(REPORT_FINDINGS_TOOL)) +
    estimateTokens(buildUserPrompt('')) +
    200;
  // Some providers (Anthropic) count output inside the context window; reserve it.
  const available = Math.floor((model.maxInputTokens - fixed - outputTokens) * 0.8);
  const chunkTokens = Math.min(options.maxChunkTokens ?? 24_000, available);
  return { chunkTokens, outputTokens };
}

/**
 * Runs a single-pass review of a diff: filter → redact → chunk → review chunks in
 * parallel → validate. Cancelling via `signal` keeps the results of finished chunks.
 */
export async function runReview(diff: UnifiedDiff, options: ReviewOptions): Promise<ReviewResult> {
  const logger = options.logger ?? noopLogger;
  const { provider, model, config } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const { files, skipped, redacted, chunks, outputTokens } = prepareReview(diff, options);
    if (redacted.count) logger.info(`redacted ${redacted.count} secret(s) before sending`);
    logger.info(
      `reviewing ${files.length} file(s) in ${chunks.length} request(s) with ${model.id}; skipped ${skipped.length}`,
    );

    const result: ReviewResult = {
      findings: [],
      usage: emptyUsage(),
      dropped: [],
      skipped,
      reviewedFiles: files.map((f) => f.path),
      chunks: { total: chunks.length, completed: 0, failed: 0, outcomes: [] },
      cancelled: false,
      errors: [],
      redactions: redacted.count,
    };
    const raw: RawFinding[] = [];
    let invalid = 0;
    let fatal: unknown;
    let firstError: unknown;
    const report = () =>
      options.onProgress?.({
        chunksTotal: chunks.length,
        chunksDone: result.chunks.completed + result.chunks.failed,
        findings: raw.length,
      });
    report();

    const queue = [...chunks];
    const worker = async () => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        if (controller.signal.aborted) return;
        await runChunk(chunk);
      }
    };
    const runChunk = async (chunk: Chunk) => {
      try {
        const review = await reviewChunk({
          provider,
          model,
          config,
          diff: renderChunk(chunk),
          signal: controller.signal,
          maxOutputTokens: outputTokens,
          logger,
        });
        result.usage = addUsage(result.usage, review.usage);
        if (review.outcome === 'cancelled') {
          raw.push(...review.findings);
          return;
        }
        raw.push(...review.findings);
        invalid += review.invalid;
        result.chunks.outcomes[chunk.index] = review.outcome;
        if (review.outcome === 'failed') {
          result.chunks.failed++;
          result.errors.push(`Part ${chunk.index + 1}: the model returned no usable findings.`);
        } else {
          result.chunks.completed++;
        }
      } catch (err) {
        if (controller.signal.aborted && !fatal) return;
        const error = toProviderError(err);
        firstError ??= error;
        result.chunks.failed++;
        result.chunks.outcomes[chunk.index] = 'failed';
        result.errors.push(`Part ${chunk.index + 1}: ${error.message}`);
        logger.error(error);
        if (isProviderError(err) && FATAL_KINDS.has(err.kind)) {
          fatal ??= err;
          controller.abort();
        }
      } finally {
        report();
      }
    };

    const concurrency = Math.max(1, options.concurrency ?? defaultConcurrency(provider.id));
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));

    if (fatal) throw fatal;
    result.cancelled = !!options.signal?.aborted;
    if (!result.cancelled && chunks.length > 0 && result.chunks.completed === 0 && firstError) {
      throw firstError;
    }
    for (let i = 0; i < chunks.length; i++) {
      result.chunks.outcomes[i] ??= 'cancelled';
    }

    const originals = new Map(files.map((f) => [f.path, f]));
    const validated = validateFindings(raw, { config, files: redacted.files, originals });
    result.findings = validated.findings;
    const dropped = new Map<DropReason, number>(validated.dropped);
    if (invalid) dropped.set('invalid', (dropped.get('invalid') ?? 0) + invalid);
    result.dropped = [...dropped].map(([reason, count]) => ({ reason, count }));
    logger.info(
      `review done: ${result.findings.length} finding(s), ${result.chunks.failed} failed part(s)${result.cancelled ? ', cancelled' : ''}`,
    );

    if (options.summary && !result.cancelled && result.chunks.completed > 0) {
      options.onProgress?.({
        chunksTotal: chunks.length,
        chunksDone: chunks.length,
        findings: result.findings.length,
        phase: 'summary',
      });
      try {
        const summary = await summarizeReview({
          provider,
          model,
          config,
          files: redacted.files,
          skipped,
          findings: result.findings,
          signal: controller.signal,
          logger,
        });
        result.usage = addUsage(result.usage, summary.usage);
        if (summary.text) result.summary = summary.text;
        if (options.signal?.aborted) result.cancelled = true;
      } catch (err) {
        // A missing summary must not lose the findings.
        const error = toProviderError(err);
        logger.warn(`summary failed: ${error.message}`);
        result.errors.push(`Summary: ${error.message}`);
      }
    }
    return result;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export interface PreparedReview {
  /** Files that will be reviewed (before redaction; used to restore quotes). */
  files: FileDiff[];
  skipped: SkippedFile[];
  redacted: { files: FileDiff[]; count: number };
  chunks: Chunk[];
  outputTokens: number;
}

type PrepareOptions = Pick<
  ReviewOptions,
  'model' | 'config' | 'redactHighEntropy' | 'maxChunkTokens' | 'maxChunks' | 'maxOutputTokens'
>;

/** Filter → redact → chunk. Throws ReviewTooLargeError when the diff needs too many requests. */
export function prepareReview(diff: UnifiedDiff, options: PrepareOptions): PreparedReview {
  const { model, config } = options;
  const { files, skipped } = filterFiles(diff.files, config.ignore);
  const redacted = redactFiles(files, { highEntropy: options.redactHighEntropy ?? false });
  const { chunkTokens, outputTokens } = chunkBudget(model, config, options);
  if (chunkTokens < 500) {
    throw new Error(`${model.name} has too small an input limit for a review.`);
  }
  const chunks = chunkFiles(redacted.files, {
    maxTokens: chunkTokens,
    ...(options.maxChunks !== undefined ? { maxChunks: options.maxChunks } : {}),
  });
  return { files, skipped, redacted, chunks, outputTokens };
}

/** Output tokens one review request typically uses: none found … many long findings. */
export const OUTPUT_TOKENS_PER_REQUEST = { low: 150, high: 2_000 } as const;
/** Output tokens of the summary request. */
export const SUMMARY_OUTPUT_TOKENS = { low: 200, high: 800 } as const;

export interface ReviewEstimate {
  /** Files that would be sent. */
  files: number;
  skipped: number;
  /** Model requests, without repair retries. */
  requests: number;
  /** Estimated input tokens (chars / 3.5), without repair retries or caching. */
  inputTokens: number;
  outputTokens: { low: number; high: number };
  /** USD; only when the model has pricing. */
  costUsd?: { low: number; high: number };
}

/**
 * Estimates what a review will send before running it: same filtering and chunking
 * as `runReview`, so the request count is exact; tokens are estimated.
 */
export function estimateReview(
  diff: UnifiedDiff,
  options: PrepareOptions & { summary?: boolean },
): ReviewEstimate {
  const { model, config } = options;
  const prepared = prepareReview(diff, options);
  const fixed =
    estimateTokens(buildSystemPrompt({ config, jsonOnly: !model.supportsTools })) +
    (model.supportsTools ? estimateTokens(JSON.stringify(REPORT_FINDINGS_TOOL)) : 0);
  let inputTokens = prepared.chunks.reduce(
    (sum, chunk) => sum + fixed + estimateTokens(buildUserPrompt(renderChunk(chunk))),
    0,
  );
  let requests = prepared.chunks.length;
  const outputTokens = {
    low: requests * OUTPUT_TOKENS_PER_REQUEST.low,
    high: requests * OUTPUT_TOKENS_PER_REQUEST.high,
  };
  if (options.summary && requests > 0) {
    requests++;
    // The summary sends at most ~12k tokens of diff plus stats and findings.
    const diffTokens = Math.min(
      12_000,
      prepared.chunks.reduce((sum, c) => sum + c.tokens, 0),
    );
    inputTokens +=
      estimateTokens(buildSummarySystemPrompt(config)) +
      diffTokens +
      prepared.redacted.files.length * 20 +
      200;
    outputTokens.low += SUMMARY_OUTPUT_TOKENS.low;
    outputTokens.high += SUMMARY_OUTPUT_TOKENS.high;
  }
  const estimate: ReviewEstimate = {
    files: prepared.files.length,
    skipped: prepared.skipped.length,
    requests,
    inputTokens,
    outputTokens,
  };
  if (model.pricing) {
    const usage = (out: number) => ({ inputTokens, outputTokens: out, requests });
    estimate.costUsd = {
      low: estimateCostUsd(usage(outputTokens.low), model.pricing),
      high: estimateCostUsd(usage(outputTokens.high), model.pricing),
    };
  }
  return estimate;
}
