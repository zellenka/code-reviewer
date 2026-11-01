import { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { ProviderError, isProviderError } from '../provider/errors';

const PROVIDER = 'anthropic';

/** Maps anything thrown by the Anthropic SDK to a ProviderError. */
export function mapAnthropicError(err: unknown): ProviderError {
  if (isProviderError(err)) return err;
  const opts = { provider: PROVIDER, cause: err };

  // Connection errors (incl. timeouts) are APIError subclasses with no status: check first.
  if (err instanceof APIConnectionError) {
    return new ProviderError('network', `Could not reach the Anthropic API: ${err.message}`, opts);
  }
  if (!(err instanceof APIError)) {
    return new ProviderError('unknown', err instanceof Error ? err.message : String(err), opts);
  }

  const message = apiMessage(err);
  const retryAfterMs = parseRetryAfter(err.headers);
  const retryOpts = retryAfterMs === undefined ? opts : { ...opts, retryAfterMs };

  // Errors sent mid-stream (SSE `error` events) have no HTTP status, only a type.
  switch (err.type) {
    case 'overloaded_error':
    case 'api_error':
    case 'timeout_error':
      return new ProviderError('server', `Anthropic API error: ${message}`, retryOpts);
    case 'rate_limit_error':
      return new ProviderError('rateLimit', `Anthropic rate limit: ${message}`, retryOpts);
    case 'billing_error':
      return new ProviderError('quota', `Anthropic billing problem: ${message}`, opts);
  }

  const status = err.status;
  if (status === 401)
    return new ProviderError('auth', `Anthropic API key was rejected: ${message}`, opts);
  if (status === 403)
    return new ProviderError('auth', `Anthropic API key lacks permission: ${message}`, opts);
  if (status === 402)
    return new ProviderError('quota', `Anthropic billing problem: ${message}`, opts);
  if (status === 404)
    return new ProviderError('notFound', `Anthropic model or endpoint not found: ${message}`, opts);
  if (status === 413)
    return new ProviderError('contextTooLong', `Request too large: ${message}`, opts);
  if (status === 429)
    return new ProviderError('rateLimit', `Anthropic rate limit: ${message}`, retryOpts);
  if (status === 408 || status === 409) return new ProviderError('network', message, retryOpts);
  if (status !== undefined && status >= 500) {
    return new ProviderError('server', `Anthropic API error (${status}): ${message}`, retryOpts);
  }
  if (
    status === 400 &&
    /prompt is too long|too many tokens|context (window|length)/i.test(message)
  ) {
    return new ProviderError('contextTooLong', message, opts);
  }
  return new ProviderError(
    'unknown',
    `Anthropic API error${status ? ` (${status})` : ''}: ${message}`,
    opts,
  );
}

function apiMessage(err: APIError): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const inner = body?.error?.message;
  return typeof inner === 'string' ? inner : err.message;
}

/** `retry-after-ms` or `retry-after` (seconds or HTTP date) → milliseconds. */
export function parseRetryAfter(
  headers: Headers | undefined,
  now = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
