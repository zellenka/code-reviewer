import type { ReviewCommandArgs } from './commands';

/**
 * Review command arguments as the caller may set them. `silent`, `confirmCost` and
 * `includeUntracked` are for tests only: from a keybinding or another extension they would
 * start a review that skips the cost confirmation (F37) or the question about untracked files.
 */
export function trustedReviewArgs(args: ReviewCommandArgs, testMode: boolean): ReviewCommandArgs {
  if (testMode) return args;
  const {
    silent: _silent,
    confirmCost: _confirmCost,
    includeUntracked: _includeUntracked,
    ...rest
  } = args;
  return rest;
}
