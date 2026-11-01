export type ProviderErrorKind =
  /** Missing/invalid credentials or no permission. */
  | 'auth'
  /** User hasn't allowed (or refused) this extension to use the model. */
  | 'consent'
  | 'rateLimit'
  /** Usage quota or billing limit reached. */
  | 'quota'
  | 'contextTooLong'
  /** Request refused by the provider (safety filter, policy). */
  | 'blocked'
  /** Model id doesn't exist or isn't available to this account. */
  | 'notFound'
  /** Provider-side failure (5xx, overloaded). */
  | 'server'
  | 'network'
  | 'unknown';

export const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  'auth',
  'consent',
  'rateLimit',
  'quota',
  'contextTooLong',
  'blocked',
  'notFound',
  'server',
  'network',
  'unknown',
];

const RETRYABLE_BY_DEFAULT: ReadonlySet<ProviderErrorKind> = new Set([
  'rateLimit',
  'server',
  'network',
]);

export interface ProviderErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  /** Provider id, e.g. 'anthropic'. */
  provider?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly provider?: string;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(kind);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.provider !== undefined) this.provider = options.provider;
  }
}

/**
 * Structural check instead of `instanceof`: the extension bundles its own copy
 * of core, so errors created by another copy (tests, other hosts) still match.
 */
export function isProviderError(value: unknown): value is ProviderError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { name?: unknown; kind?: unknown; retryable?: unknown };
  return (
    v.name === 'ProviderError' &&
    typeof v.retryable === 'boolean' &&
    PROVIDER_ERROR_KINDS.includes(v.kind as ProviderErrorKind)
  );
}

/** Wraps anything thrown into a ProviderError (kind `unknown` if not one already). */
export function toProviderError(value: unknown, provider?: string): ProviderError {
  if (isProviderError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new ProviderError('unknown', message, {
    cause: value,
    ...(provider === undefined ? {} : { provider }),
  });
}
