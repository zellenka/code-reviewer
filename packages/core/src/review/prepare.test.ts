import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { parseUnifiedDiff } from '../diff/parse';
import { MockProvider, mockToolCall } from '../provider/mock';
import type { ModelInfo } from '../provider/types';
import type * as FilterModule from './filter';
import { filterFiles } from './filter';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, prepareDiff, runReview } from './orchestrator';
import type * as RedactModule from './redact';
import { redactFiles } from './redact';

// Pass-through spies: count how often a review filters and redacts the diff.
vi.mock('./filter', async (importOriginal) => {
  const actual = await importOriginal<typeof FilterModule>();
  return { ...actual, filterFiles: vi.fn(actual.filterFiles) };
});
vi.mock('./redact', async (importOriginal) => {
  const actual = await importOriginal<typeof RedactModule>();
  return { ...actual, redactFiles: vi.fn(actual.redactFiles) };
});

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
};

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const diffOf = (second: string) =>
  parseUnifiedDiff(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old a',
      `+const key = "${KEY}";`,
      '@@ -20,1 +20,1 @@',
      '-old b',
      `+${second}`,
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1,1 +1,1 @@',
      '-A=1',
      '+A=2',
      '',
    ].join('\n'),
  );

const provider = () =>
  new MockProvider({ fallback: mockToolCall(REPORT_TOOL_NAME, { findings: [] }) });
const options = { model: MODEL, config: DEFAULT_CONFIG, summary: true };
const calls = () => ({
  filter: vi.mocked(filterFiles).mock.calls.length,
  redact: vi.mocked(redactFiles).mock.calls.length,
});

describe('one prepared diff per review', () => {
  beforeEach(() => {
    vi.mocked(filterFiles).mockClear();
    vi.mocked(redactFiles).mockClear();
  });

  it('a review filters and redacts the diff once', async () => {
    const result = await runReview(diffOf('x = 1;'), { ...options, provider: provider() });
    expect(result.redactions).toBe(1);
    expect(calls()).toEqual({ filter: 1, redact: 1 });
  });

  it('an incremental review filters and redacts the diff once', async () => {
    const first = await runReview(diffOf('x = 1;'), { ...options, provider: provider() });
    vi.mocked(filterFiles).mockClear();
    vi.mocked(redactFiles).mockClear();

    const p = provider();
    const result = await runReview(diffOf('x = 2;'), {
      ...options,
      provider: p,
      previous: first.snapshot!,
    });
    expect(result.incremental).toEqual({ newHunks: 1, reusedHunks: 1, carried: 0 });
    // The new hunk, then the summary of the whole change.
    expect(p.requests).toHaveLength(2);
    expect(calls()).toEqual({ filter: 1, redact: 1 });
  });

  it('the estimate and the review share one prepared diff', async () => {
    const first = await runReview(diffOf('x = 1;'), { ...options, provider: provider() });
    vi.mocked(filterFiles).mockClear();
    vi.mocked(redactFiles).mockClear();

    const reviewOptions = { ...options, previous: first.snapshot! };
    const prepared = prepareDiff(diffOf('x = 2;'), reviewOptions);
    // What the host loads symbols for: the files that will be reviewed, as in the diff.
    expect(prepared.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(prepared.skipped).toEqual([{ path: '.env', reason: 'secret' }]);
    const estimate = estimateReview(prepared, reviewOptions);
    const result = await runReview(prepared, { ...reviewOptions, provider: provider() });
    expect(estimate.requests).toBe(2);
    expect(result.incremental).toMatchObject({ newHunks: 1 });
    expect(calls()).toEqual({ filter: 1, redact: 1 });
  });

  it('sends the new hunk of a path the diff names twice', async () => {
    // The snapshot keeps the hunks of the path's last entry: change the first one.
    const twice = (first: string) =>
      parseUnifiedDiff(
        [first, 'y = 1;']
          .flatMap((text) => [
            'diff --git a/src/x.ts b/src/x.ts',
            '--- a/src/x.ts',
            '+++ b/src/x.ts',
            '@@ -1,1 +1,1 @@',
            '-old',
            `+${text}`,
          ])
          .join('\n') + '\n',
      );
    const first = await runReview(twice('x = 1;'), { ...options, provider: provider() });

    const prepared = prepareDiff(twice('x = 2;'), { ...options, previous: first.snapshot! });
    expect(prepared.plan).toMatchObject({ newHunks: 1, reusedHunks: 1 });
    expect(prepared.review.redacted.map((f) => f.hunks.map((h) => h.lines[1]!.text))).toEqual([
      ['x = 2;'],
    ]);
  });
});
