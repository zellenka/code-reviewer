import type { AgentLimits, AgentTool } from '../agent/loop';
import type { ReviewConfig } from '../config/schema';
import type { Logger } from '../logger';
import { isProviderError, toProviderError } from '../provider/errors';
import type { ChatEvent, ChatRequest, LLMProvider, ModelInfo } from '../provider/types';
import { addUsage } from '../provider/usage';
import { renderChunk, type Chunk } from './chunker';
import type { PreparedReview } from './prepare';
import { reviewChunk } from './reviewer';
import type { RawFinding, ReviewResult } from './types';

/** Errors that will fail every chunk the same way: stop the whole review. */
const FATAL_KINDS = new Set(['auth', 'consent', 'quota', 'notFound']);

export function defaultConcurrency(providerId: string): number {
  return providerId === 'anthropic' ? 4 : 2;
}

export interface PartsOptions {
  provider: LLMProvider;
  model: ModelInfo;
  config: ReviewConfig;
  prepared: PreparedReview;
  /** Agentic parts: the tools and limits. */
  agent?: { tools: AgentTool<never>[]; limits: AgentLimits };
  concurrency: number;
  /** Aborted to stop every part (by the caller, or here on a fatal error). */
  controller: AbortController;
  /** The caller's signal: aborted means cancelled, not failed. */
  signal?: AbortSignal;
  logger: Logger;
  /** Updated as parts finish: usage, agent stats, chunk outcomes, errors and `cancelled`. */
  result: ReviewResult;
  /** Called before the first part and after each one, with the findings so far. */
  onPartDone?: (findings: number) => void;
}

/**
 * Reviews the prepared parts, `concurrency` at a time. With prompt caching the first part
 * goes alone until its response starts, so the others can read the cached prefix. A fatal
 * error (auth, quota, …) stops the review and is thrown; so is the first error when every
 * part failed. Cancelling keeps the finished parts; the others are marked cancelled.
 */
export async function reviewParts(
  options: PartsOptions,
): Promise<{ raw: RawFinding[]; invalid: number }> {
  const { provider, model, config, prepared, agent, controller, logger, result } = options;
  const { chunks, outputTokens } = prepared;
  const raw: RawFinding[] = [];
  let invalid = 0;
  let fatal: unknown;
  let firstError: unknown;
  const report = () => options.onPartDone?.(raw.length);
  report();

  // Prompt caching: a cache entry is readable once the first response starts streaming,
  // so the first part goes alone until then; the others read the shared prefix.
  const concurrency = options.concurrency;
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
        // Counted per response: a part that throws later still used these tokens.
        onUsage: (usage) => (result.usage = addUsage(result.usage, usage)),
      });
      if (review.agent && result.agent) {
        result.agent.turns += review.agent.turns;
        result.agent.toolCalls += review.agent.toolCalls;
        if (review.agent.wrapUp && review.agent.wrapUp !== 'noToolCall') result.agent.limitStops++;
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
  return { raw, invalid };
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
