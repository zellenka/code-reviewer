import { describe, expect, it } from 'vitest';
import { trustedReviewArgs } from './args';

describe('review command arguments (F37)', () => {
  const args = { root: '/repo', path: 'a.ts', startLine: 1, endLine: 2, base: 'main' };

  it('outside tests, drops the options that skip the cost confirmation or hide notifications', () => {
    expect(trustedReviewArgs({ ...args, silent: true, confirmCost: true }, false)).toEqual(args);
  });

  it('in tests, keeps them', () => {
    expect(trustedReviewArgs({ ...args, silent: true, confirmCost: true }, true)).toEqual({
      ...args,
      silent: true,
      confirmCost: true,
    });
  });
});
