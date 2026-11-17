import type { ReviewCommandArgs } from './commands';

/**
 * Review command arguments as the caller may set them. `silent` and `confirmCost` are for
 * tests only: from a keybinding or another extension they would start a review that skips
 * the cost confirmation (F37).
 */
export function trustedReviewArgs(args: ReviewCommandArgs, testMode: boolean): ReviewCommandArgs {
  if (testMode) return args;
  const { silent: _silent, confirmCost: _confirmCost, ...rest } = args;
  return rest;
}
