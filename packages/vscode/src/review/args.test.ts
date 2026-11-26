import { describe, expect, it } from 'vitest';
import { trustedReviewArgs } from './args';

describe('review command arguments (F37)', () => {
  const args = { root: '/repo', path: 'a.ts', startLine: 1, endLine: 2, base: 'main' };

  const testOnly = { silent: true, confirmCost: true, includeUntracked: true };

  it('outside tests, drops the options that skip a question or hide notifications', () => {
    expect(trustedReviewArgs({ ...args, ...testOnly }, false)).toEqual(args);
  });

  it('in tests, keeps them', () => {
    expect(trustedReviewArgs({ ...args, ...testOnly }, true)).toEqual({ ...args, ...testOnly });
  });
});
