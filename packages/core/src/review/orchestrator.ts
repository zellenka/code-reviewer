import { DEFAULT_AGENT_LIMITS, type AgentLimits, type AgentTool } from '../agent/loop';
import { createReviewTools } from '../agent/tools';
import type { ReviewConfig } from '../config/schema';
import type { FileDiff, UnifiedDiff, WorkspaceTools } from '../diff/types';
import { noopLogger, type Logger } from '../logger';
import { isProviderError, toProviderError } from '../provider/errors';
import type {
  ChatEvent,
  ChatRequest,
  LLMProvider,
  ModelInfo,
  ToolDef,
  Usage,
} from '../provider/types';
import { addUsage, emptyUsage, estimateCostUsd, estimateTokens } from '../provider/usage';
import { chunkFiles, renderChunk, type Chunk } from './chunker';
import { buildFileContext, changedSymbols, renderChangedSymbols } from './context';
import { compileGlobs, filterFiles } from './filter';
import { buildSystemBlocks, buildUserPrompt } from './prompt';
import { REPORT_FINDINGS_TOOL } from './output';
import { redactFiles } from './redact';
import { reviewChunk } from './reviewer';
import { renderRules, type RepoRules } from './rules';
import { buildSummarySystemPrompt, summarizeReview } from './summarize';
import type { SymbolIndex } from './symbols';
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
}

/** Errors that will fail every chunk the same way: stop the whole review. */
const FATAL_KINDS = new Set(['auth', 'consent', 'quota', 'notFound']);

export function defaultConcurrency(providerId: string): number {
  return providerId === 'anthropic' ? 4 : 2;
}

/** Tool definitions an agentic review sends (for budgets and estimates). */
const AGENT_TOOL_DEFS: ToolDef[] = createReviewTools({
  readFile: () => Promise.resolve(''),
  grep: () => Promise.resolve([]),
  findReferences: () => Promise.resolve([]),
  getSymbolAt: () => Promise.resolve(null),
}).map((t) => t.def);

/**
 * Tokens one chunk may use: input limit − fixed prompt parts − output reserve, with a 20%
 * margin because token counts are estimated. `fixedTokens` = system + tools + shared text;
 * by default the single-pass prompt without rules. Agentic parts get half, leaving room
 * for tool results.
 */
export function chunkBudget(
  model: ModelInfo,
  config: ReviewConfig,
  options: {
    maxChunkTokens?: number;
    maxOutputTokens?: number;
    fixedTokens?: number;
    agentic?: boolean;
  } = {},
): { chunkTokens: number; outputTokens: number } {
  const outputTokens = options.maxOutputTokens ?? Math.min(model.maxOutputTokens, 16_000);
  const fixed =
    (options.fixedTokens ??
      estimateTokens(buildSystemBlocks({ config, jsonOnly: !model.supportsTools })[0]!.text) +
        estimateTokens(JSON.stringify(REPORT_FINDINGS_TOOL))) +
    estimateTokens(buildUserPrompt('')) +
    200;
  // Some providers (Anthropic) count output inside the context window; reserve it.
  const available = Math.floor((model.maxInputTokens - fixed - outputTokens) * 0.8);
  const chunkTokens = Math.min(
    options.maxChunkTokens ?? 24_000,
    options.agentic ? Math.floor(available / 2) : available,
  );
  return { chunkTokens, outputTokens };
}

/**
 * Runs a review of a diff: filter → redact → add context → chunk → review chunks in
 * parallel (single-pass, or agentic with read-only tools) → validate. Cancelling via
 * `signal` keeps the results of finished chunks.
 */
export async function runReview(diff: UnifiedDiff, options: ReviewOptions): Promise<ReviewResult> {
  const logger = options.logger ?? noopLogger;
  const { provider, model, config } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const prepared = prepareReview(diff, options);
    const { files, skipped, redacted, chunks, outputTokens, mode } = prepared;
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
    const agent =
      mode === 'agentic'
        ? {
            tools: createReviewTools(options.workspace!, {
              redactHighEntropy: options.redactHighEntropy ?? false,
              // Files the repo's `ignore:` hides from the diff stay hidden from the tools.
              ...(config.ignore.length ? { isBlocked: compileGlobs(config.ignore) } : {}),
            }) as AgentTool<never>[],
            limits: prepared.agentLimits,
          }
        : undefined;

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
      mode,
    };
    if (options.rules?.sources.length) result.rules = options.rules.sources.map((s) => s.path);
    if (agent) result.agent = { turns: 0, toolCalls: 0, limitStops: 0 };
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

    // Prompt caching: a cache entry is readable once the first response starts streaming,
    // so the first part goes alone until then; the others read the shared prefix.
    const concurrency = Math.max(1, options.concurrency ?? defaultConcurrency(provider.id));
    const warmUp =
      chunks.length > 1 &&
      concurrency > 1 &&
      !!model.promptCaching &&
      prepared.sharedPrefixTokens >= model.promptCaching.minTokens;
    let warmed!: () => void;
    const warm = new Promise<void>((resolve) => (warmed = resolve));
    if (!warmUp) warmed();
    const onAbortWarm = () => warmed();
    controller.signal.addEventListener('abort', onAbortWarm, { once: true });

    const queue = [...chunks];
    const worker = async (n: number) => {
      if (n > 0) await warm;
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        if (controller.signal.aborted) return;
        await runChunk(
          chunk,
          chunk.index === 0 && warmUp ? onFirstEvent(provider, warmed) : provider,
        );
      }
    };
    const runChunk = async (chunk: Chunk, chunkProvider: LLMProvider) => {
      try {
        const review = await reviewChunk({
          provider: chunkProvider,
          model,
          config,
          diff: renderChunk(chunk),
          signal: controller.signal,
          maxOutputTokens: outputTokens,
          logger,
          system: prepared.system,
          ...(prepared.shared ? { shared: prepared.shared } : {}),
          ...(agent ? { agent } : {}),
          label: `part ${chunk.index + 1}`,
        });
        result.usage = addUsage(result.usage, review.usage);
        if (review.agent && result.agent) {
          result.agent.turns += review.agent.turns;
          result.agent.toolCalls += review.agent.toolCalls;
          if (review.agent.wrapUp && review.agent.wrapUp !== 'noToolCall')
            result.agent.limitStops++;
        }
        raw.push(...review.findings);
        if (review.outcome === 'cancelled') return;
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
        if (chunk.index === 0) warmed();
        report();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, chunks.length) }, (_, n) => worker(n)),
    );
    controller.signal.removeEventListener('abort', onAbortWarm);

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
      `review done: ${result.findings.length} finding(s), ${result.chunks.failed} failed part(s)${result.agent ? `, ${result.agent.toolCalls} tool call(s) in ${result.agent.turns} turn(s)` : ''}${result.cancelled ? ', cancelled' : ''}`,
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
        // Cancelling here only loses the summary: the findings are complete.
        if (summary.text) result.summary = summary.text;
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

/** Wraps a provider so `onFirst` runs when the first stream event arrives (or the call ends). */
function onFirstEvent(provider: LLMProvider, onFirst: () => void): LLMProvider {
  return {
    id: provider.id,
    listModels: () => provider.listModels(),
    countTokens: (model, text) => provider.countTokens(model, text),
    async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      try {
        for await (const event of provider.chat(req)) {
          onFirst();
          yield event;
        }
      } finally {
        onFirst();
      }
    },
  };
}

export interface PreparedReview {
  /** Files that will be reviewed (before redaction; used to restore quotes). */
  files: FileDiff[];
  skipped: SkippedFile[];
  redacted: { files: FileDiff[]; count: number };
  chunks: Chunk[];
  outputTokens: number;
  mode: 'single-pass' | 'agentic';
  /** System blocks of every review request (prompt + rules). */
  system: { text: string; cache?: boolean }[];
  /** Changed-symbols index sent before each part's diff. */
  shared?: string;
  /** Tools sent with every review request. */
  tools: ToolDef[];
  /** Estimated tokens of the prefix shared by all parts (tools + system + shared). */
  sharedPrefixTokens: number;
  agentLimits: AgentLimits;
}

type PrepareOptions = Pick<
  ReviewOptions,
  | 'model'
  | 'config'
  | 'redactHighEntropy'
  | 'maxChunkTokens'
  | 'maxChunks'
  | 'maxOutputTokens'
  | 'context'
  | 'symbols'
  | 'rules'
  | 'agentLimits'
> & {
  /** Whether repo access is available (`ReviewOptions.workspace`). */
  workspace?: unknown;
};

/**
 * Filter → redact → context → chunk. Throws ReviewTooLargeError when the diff needs too
 * many requests.
 */
export function prepareReview(diff: UnifiedDiff, options: PrepareOptions): PreparedReview {
  const { model, config } = options;
  const jsonOnly = !model.supportsTools;
  const mode =
    config.review.mode === 'agentic' && options.workspace && model.supportsTools
      ? 'agentic'
      : 'single-pass';
  const agentLimits = { ...DEFAULT_AGENT_LIMITS, ...options.agentLimits };
  const { files, skipped } = filterFiles(diff.files, config.ignore);
  const redacted = redactFiles(files, { highEntropy: options.redactHighEntropy ?? false });

  const rules = renderRules(options.rules);
  const system = buildSystemBlocks({
    config,
    jsonOnly,
    ...(mode === 'agentic'
      ? { agent: { maxTurns: agentLimits.maxTurns, maxToolCalls: agentLimits.maxToolCalls } }
      : {}),
    ...(rules ? { rules } : {}),
  });
  const tools = jsonOnly
    ? []
    : mode === 'agentic'
      ? [...AGENT_TOOL_DEFS, REPORT_FINDINGS_TOOL]
      : [REPORT_FINDINGS_TOOL];
  const withContext = options.context ?? true;
  const shared = withContext
    ? renderChangedSymbols(changedSymbols(redacted.files, options.symbols))
    : undefined;
  const sharedPrefixTokens =
    estimateTokens(system.map((s) => s.text).join('\n')) +
    (tools.length ? estimateTokens(JSON.stringify(tools)) : 0) +
    (shared ? estimateTokens(shared) : 0);

  const { chunkTokens, outputTokens } = chunkBudget(model, config, {
    ...options,
    fixedTokens: sharedPrefixTokens,
    agentic: mode === 'agentic',
  });
  if (chunkTokens < 500) {
    throw new Error(`${model.name} has too small an input limit for a review.`);
  }
  const contextTokens = Math.min(3_000, Math.floor(chunkTokens * 0.25));
  const chunks = chunkFiles(redacted.files, {
    maxTokens: chunkTokens,
    ...(options.maxChunks !== undefined ? { maxChunks: options.maxChunks } : {}),
    ...(withContext
      ? {
          context: (file, hunks) =>
            buildFileContext(file, hunks, options.symbols?.get(file.path), {
              maxTokens: contextTokens,
            }),
        }
      : {}),
  });
  const prepared: PreparedReview = {
    files,
    skipped,
    redacted,
    chunks,
    outputTokens,
    mode,
    system,
    tools,
    sharedPrefixTokens,
    agentLimits,
  };
  if (shared) prepared.shared = shared;
  return prepared;
}

/** Output tokens one review request typically uses: none found … many long findings. */
export const OUTPUT_TOKENS_PER_REQUEST = { low: 150, high: 2_000 } as const;
/** Extra output per agentic turn (tool calls) at the high end. */
export const OUTPUT_TOKENS_PER_AGENT_TURN = 400;
/** Output tokens of the summary request. */
export const SUMMARY_OUTPUT_TOKENS = { low: 200, high: 800 } as const;

export interface ReviewEstimate {
  mode: 'single-pass' | 'agentic';
  /** Files that would be sent. */
  files: number;
  skipped: number;
  /** Model requests, without repair retries. Agentic: one per part (more turns may follow). */
  requests: number;
  /** Estimated input tokens (chars / 3.5), without repair retries. Cached tokens included. */
  inputTokens: number;
  /** Agentic only: input tokens if every part uses its whole agent token budget. */
  inputTokensHigh?: number;
  outputTokens: { low: number; high: number };
  /** USD; only when the model has pricing. Prompt caching of the shared prefix is included. */
  costUsd?: { low: number; high: number };
}

/**
 * Estimates what a review will send before running it: same filtering, context and
 * chunking as `runReview`, so the request count is exact for single-pass; tokens are
 * estimated. Agentic reviews get a range: one turn per part … the whole agent budget.
 */
export function estimateReview(
  diff: UnifiedDiff,
  options: PrepareOptions & { summary?: boolean },
): ReviewEstimate {
  const { model, config } = options;
  const prepared = prepareReview(diff, options);
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
      high: estimateCostUsd(
        usage(inputTokensHigh ?? inputTokens, outputTokens.high),
        model.pricing,
      ),
    };
  }
  return estimate;
}
