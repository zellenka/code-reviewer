export type DiffSourceErrorKind =
  | 'noRepo'
  | 'detachedHead'
  | 'noBase'
  /** A commit to review doesn't exist, or the commits aren't one run of history. */
  | 'noCommit'
  | 'notFound'
  | 'outsideRepo'
  | 'ignored'
  | 'git';

/** A diff could not be produced. `message` is safe to show to the user. */
export class DiffSourceError extends Error {
  override readonly name = 'DiffSourceError';
  constructor(
    readonly kind: DiffSourceErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Structural check: works across bundle boundaries where `instanceof` doesn't. */
export function isDiffSourceError(err: unknown): err is DiffSourceError {
  return (
    err instanceof Error &&
    err.name === 'DiffSourceError' &&
    typeof (err as { kind?: unknown }).kind === 'string'
  );
}
