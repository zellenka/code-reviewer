import type { AgentLimits, AgentTool } from '../agent/loop';
import { createReviewTools } from '../agent/tools';
import type { ReviewConfig } from '../config/schema';
import type { UnifiedDiff, WorkspaceTools } from '../diff/types';
import { noopLogger, type Logger } from '../logger';
import type { LLMProvider, ModelInfo } from '../provider/types';
import { emptyUsage } from '../provider/usage';
import { repoIgnoreBlocks } from './filter';
import type { ReviewSnapshot } from './incremental';
import { addSnapshot, addSummary, checkFindings, mergeCarried } from './postprocess';
import { prepareParts, toPreparedDiff, type PreparedDiff } from './prepare';
import { reviewSettingsWarnings, type RepoRules } from './rules';
import { defaultConcurrency, reviewParts } from './schedule';
import type { SymbolIndex } from './symbols';
import type { ReviewResult } from './types';

// The review's parts live in their own modules; this entry point keeps exporting them.
export {
  OUTPUT_TOKENS_PER_AGENT_TURN,
  OUTPUT_TOKENS_PER_REQUEST,
  SUMMARY_OUTPUT_TOKENS,
  VERIFY_OUTPUT_TOKENS_PER_REQUEST,
  estimateReview,
  type ReviewEstimate,
} from './estimate';
export {
  chunkBudget,
  prepareDiff,
  prepareReview,
  type PrepareDiffOptions,
  type PrepareOptions,
  type PreparedDiff,
  type PreparedReview,
} from './prepare';
export { defaultConcurrency } from './schedule';

export interface ReviewProgress {
  chunksTotal: number;
  chunksDone: number;
  findings: number;
  /** 'verify' / 'summary' while those requests run. */
  phase?: 'review' | 'verify' | 'summary';
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
  /**
   * Show the enclosing function/class of each change and, for multi-file reviews, the
   * declarations changed across the diff. Default true.
   */
  context?: boolean;
  /** Language-server symbols for the context. Files missing here use a heuristic. */
  symbols?: SymbolIndex;
  /** Repo rules (`.codereview.md`, AGENTS.md, …), loaded by the host. */
  rules?: RepoRules;
  /**
   * Read-only repo access. Needed for `review.mode: agentic`; without it (or with a model
   * that can't call tools) the review runs single-pass.
   */
  workspace?: WorkspaceTools;
  /** Per-part limits of the agentic reviewer. */
  agentLimits?: Partial<AgentLimits>;
  /** Verify pass: a second request per file asks whether each finding is real. Default: `config.review.verify`. */
  verify?: boolean;
  /** Model for the verify pass (same provider), e.g. a cheaper one. Default: `model`. */
  verifyModel?: ModelInfo;
  /**
   * What the repository's config turned down (`resolveReviewConfig().relaxed`). Added to
   * the result's warnings, so the user sees it with every review.
   */
  relaxed?: string[];
  /**
   * The last review of the same scope (`ReviewResult.snapshot`). Hunks reviewed then are
   * not sent again and their findings are carried over. Ignored when the model, mode,
   * config, rules or prompts changed since.
   */
  previous?: ReviewSnapshot;
}

/**
 * Runs a review of a diff: filter → redact → plan → add context → chunk → review chunks
 * in parallel (single-pass, or agentic with read-only tools) → validate → verify → merge
 * carried findings → summary. `diff` may be prepared already (`prepareDiff`, same
 * options). Cancelling via `signal` keeps the results of finished chunks.
 */
export async function runReview(
  diff: UnifiedDiff | PreparedDiff,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const logger = options.logger ?? noopLogger;
  const { provider, model, config } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const diffPrepared = toPreparedDiff(diff, options);
    const { plan } = diffPrepared;
    if (diffPrepared.previous && !plan) {
      logger.info(
        'model, mode, settings, rules or prompts changed since the last review: reviewing everything',
      );
    }
    const prepared = prepareParts(diffPrepared, options);
    const { files, redacted, chunks, mode } = prepared;
    const skipped = diffPrepared.skipped;
    if (plan) {
      logger.info(
        `incremental review: ${plan.newHunks} new hunk(s), ${plan.reusedHunks} reviewed before, ${plan.carried.length} finding(s) carried over`,
      );
    }
    if (config.review.mode === 'agentic' && mode !== 'agentic') {
      logger.warn(
        model.supportsTools
          ? 'agentic review needs repository access here; running single-pass'
          : `${model.name} can't call tools; running single-pass instead of agentic`,
      );
    }
    if (redacted.count) logger.info(`redacted ${redacted.count} secret(s) before sending`);
    logger.info(
      `reviewing ${files.length} file(s) in ${chunks.length} request(s) with ${model.id} (${mode}); skipped ${skipped.length}`,
    );
    const isBlocked = repoIgnoreBlocks(config);
    const agent =
      mode === 'agentic'
        ? {
            tools: createReviewTools(options.workspace!, {
              redactHighEntropy: options.redactHighEntropy ?? false,
              // Files the repo's `ignore:` hides from the diff stay hidden from the tools.
              ...(isBlocked ? { isBlocked } : {}),
            }) as AgentTool<never>[],
            limits: prepared.agentLimits,
          }
        : undefined;

    const result: ReviewResult = {
      findings: [],
      usage: emptyUsage(),
      dropped: [],
      skipped,
      reviewedFiles: diffPrepared.files.map((f) => f.path),
      chunks: { total: chunks.length, completed: 0, failed: 0, outcomes: [] },
      cancelled: false,
      errors: [],
      redactions: redacted.count,
      mode,
    };
    if (options.rules?.sources.length) result.rules = options.rules.sources.map((s) => s.path);
    // The whole diff, not the incremental part: the warning holds for every re-review.
    const warnings = [
      ...reviewSettingsWarnings(diffPrepared.diff.files, config, diffPrepared.relaxedIgnore),
      ...(options.relaxed ?? []),
    ];
    if (warnings.length) result.warnings = warnings;
    if (agent) result.agent = { turns: 0, toolCalls: 0, limitStops: 0 };
    const progress = (findings: number, phase?: ReviewProgress['phase']) =>
      options.onProgress?.({
        chunksTotal: chunks.length,
        chunksDone: phase ? chunks.length : result.chunks.completed + result.chunks.failed,
        findings,
        ...(phase ? { phase } : {}),
      });

    const concurrency = Math.max(1, options.concurrency ?? defaultConcurrency(provider.id));
    const { raw, invalid } = await reviewParts({
      provider,
      model,
      config,
      prepared,
      ...(agent ? { agent } : {}),
      concurrency,
      controller,
      ...(options.signal ? { signal: options.signal } : {}),
      logger,
      result,
      onPartDone: (findings) => progress(findings),
    });

    const call = { provider, model, config, signal: controller.signal, logger };
    const verify = options.verify ?? config.review.verify;
    const dropped = await checkFindings(raw, invalid, {
      ...call,
      diff: diffPrepared,
      result,
      ...(verify ? { verifyModel: options.verifyModel ?? model } : {}),
      concurrency,
      ...(options.signal ? { cancelSignal: options.signal } : {}),
      onVerify: () => progress(result.findings.length, 'verify'),
    });
    if (plan) mergeCarried(result, plan);
    result.dropped = [...dropped].map(([reason, count]) => ({ reason, count }));
    logger.info(
      `review done: ${result.findings.length} finding(s), ${result.chunks.failed} failed part(s)${result.agent ? `, ${result.agent.toolCalls} tool call(s) in ${result.agent.turns} turn(s)` : ''}${result.cancelled ? ', cancelled' : ''}`,
    );

    if (options.summary) {
      await addSummary({
        ...call,
        diff: diffPrepared,
        result,
        parts: chunks.length,
        onSummary: () => progress(result.findings.length, 'summary'),
      });
    }
    addSnapshot(result, diffPrepared);
    return result;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
