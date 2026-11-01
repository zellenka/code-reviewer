import { noopLogger, type Logger } from '../logger';
import { ProviderError, toProviderError } from './errors';
import type { ChatEvent } from './types';

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry (with jitter). Default 1000. */
  baseDelayMs?: number;
  /** Longest single wait. A `retryAfterMs` above this fails instead of waiting. Default 60000. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * Re-runs `attempt` on retryable ProviderErrors (rate limit, 5xx, network),
 * honouring `retryAfterMs`. Only retries if nothing was yielded yet, so callers
 * never see duplicated partial output.
 */
export async function* withRetry(
  attempt: () => AsyncIterable<ChatEvent>,
  options: RetryOptions = {},
): AsyncIterable<ChatEvent> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const logger = options.logger ?? noopLogger;
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let retry = 0; ; retry++) {
    let yielded = false;
    try {
      for await (const event of attempt()) {
        yielded = true;
        yield event;
      }
      return;
    } catch (err) {
      const error = toProviderError(err);
      if (yielded || !error.retryable || retry >= maxRetries || options.signal?.aborted) {
        throw error;
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** retry * (0.75 + random() * 0.5));
      const delay = error.retryAfterMs ?? backoff;
      if (delay > maxDelayMs) {
        throw new ProviderError(
          error.kind,
          `${error.message} (retry after ${Math.ceil(delay / 1000)}s)`,
          {
            retryable: false,
            retryAfterMs: delay,
            cause: error,
            ...(error.provider === undefined ? {} : { provider: error.provider }),
          },
        );
      }
      logger.warn(
        `${error.provider ?? 'provider'}: ${error.kind} error, retry ${retry + 1}/${maxRetries} in ${Math.round(delay)}ms: ${error.message}`,
      );
      await wait(delay, options.signal);
      if (options.signal?.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
    }
  }
}
