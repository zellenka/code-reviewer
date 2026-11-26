import { describe, expect, it } from 'vitest';
import {
  findingChatPrompt,
  reviewChatPrompt,
  reviewToMarkdown,
  type ReportFinding,
} from './report';
import type { Finding, ReviewResult } from './types';

const finding = (over: Partial<ReportFinding> = {}): ReportFinding => ({
  id: 'x',
  file: 'src/calc.ts',
  startLine: 4,
  endLine: 4,
  anchor: 'line',
  severity: 'major',
  category: 'bug',
  title: 'sub() adds instead of subtracting',
  body: 'It returns `a + b`.',
  quote: 'return a + b;',
  suggestion: 'return a - b;',
  confidence: 0.9,
  ...over,
});

const result = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  findings: [],
  summary: 'Changes `sub`.',
  usage: { inputTokens: 1000, outputTokens: 200, requests: 2 },
  dropped: [],
  skipped: [{ path: '.env', reason: 'secret' }],
  reviewedFiles: ['src/calc.ts', 'src/a.ts'],
  chunks: { total: 1, completed: 1, failed: 0, outcomes: ['valid'] },
  cancelled: false,
  errors: [],
  redactions: 0,
  mode: 'single-pass',
  ...over,
});

describe('reviewToMarkdown', () => {
  it('lists the summary, open findings by file (worst first) with code and fix, and details', () => {
    const findings: ReportFinding[] = [
      finding({ file: 'src/a.ts', severity: 'minor', title: 'Minor one', suggestion: undefined }),
      finding(),
      finding({
        file: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        severity: 'nit',
        title: 'Nit',
        status: 'dismissed',
      }),
      finding({ title: 'Fixed', status: 'resolved' }),
    ];
    const md = reviewToMarkdown({
      scope: 'commit abc1234',
      model: 'Stub',
      finishedAt: new Date(2026, 10, 26, 9, 5),
      result: result(),
      findings,
      costUsd: 0.0123,
    });
    expect(md).toMatch(
      /^# AI Review: commit abc1234\n\n_Stub · 2026-11-26 09:05 · 2 open finding\(s\) \(1 major, 1 minor\)_/,
    );
    expect(md).toContain('## Summary\n\nChanges `sub`.');
    // The file with the major finding comes first; resolved and dismissed ones are only counted.
    expect(md.indexOf('### `src/calc.ts`')).toBeLessThan(md.indexOf('### `src/a.ts`'));
    expect(md).toContain(
      '#### 1. sub() adds instead of subtracting\n\n**major** · bug · line 4 · confidence 0.90\n\nIt returns `a + b`.\n\n```ts\nreturn a + b;\n```\n\nSuggested fix:\n\n```ts\nreturn a - b;\n```',
    );
    expect(md).toContain('#### 2. Minor one');
    expect(md).not.toContain('Nit');
    expect(md).not.toContain('Fixed');
    expect(md).toContain('- Not listed: 1 resolved, 1 dismissed');
    expect(md).toContain('- Not reviewed: `.env` (secret)');
    expect(md).toContain('- Tokens: 1000 in, 200 out, 2 request(s)');
    expect(md).toContain('- Cost: about $0.0123');
  });

  it('quotes code as the model saw it: redacted, fenced past its own backticks', () => {
    const md = reviewToMarkdown({
      scope: 'x',
      model: 'Stub',
      result: result(),
      findings: [
        finding({
          quote: 'const key = "sk-real";',
          redactedQuote: 'const key = "[REDACTED]";',
          suggestion: 'const s = ```;',
        }),
      ],
    });
    expect(md).not.toContain('sk-real');
    expect(md).toContain('```ts\nconst key = "[REDACTED]";\n```');
    expect(md).toContain('````ts\nconst s = ```;\n````');
  });

  it('neutralizes model text and keeps odd file names in one inline code span', () => {
    const md = reviewToMarkdown({
      scope: 'x',
      model: 'Stub',
      result: result({ summary: 'See ![x](https://evil.example/?q=1) <img src=x>' }),
      findings: [finding({ file: 'a`b\n# c.ts', title: 'Title\n# injected', body: '<script>' })],
    });
    expect(md).toContain('\\![x](https://evil.example/?q=1) &lt;img src=x>');
    expect(md).toContain('### ``a`b # c.ts``');
    expect(md).toContain('#### 1. Title # injected');
    expect(md).toContain('&lt;script>');
  });

  it('says when nothing is open, a review was cancelled, or findings were left out', () => {
    const none = reviewToMarkdown({
      scope: 'x',
      model: 'Stub',
      result: result({ cancelled: true }),
      findings: [],
    });
    expect(none).toContain('no open findings');
    expect(none).toContain('No open findings.');
    expect(none).toContain('> Cancelled');

    const many = Array.from({ length: 5 }, (_, i) =>
      finding({
        title: `F${i}`,
        severity: i === 3 ? 'critical' : 'nit',
        startLine: i + 1,
        endLine: i + 1,
      }),
    );
    const md = reviewToMarkdown(
      { scope: 'x', model: 'Stub', result: result(), findings: many },
      { maxFindings: 2 },
    );
    expect(md).toContain('F3');
    expect((md.match(/^#### /gm) ?? []).length).toBe(2);
    expect(md).toContain('_3 less severe finding(s) not listed._');
  });
});

describe('chat prompts', () => {
  it('a finding: what to do, where it is, the code and the fix', () => {
    const prompt = findingChatPrompt(finding({ startLine: 4, endLine: 6 }) as Finding, {
      file: 'repo/src/calc.ts',
    });
    expect(prompt).toMatch(
      /^Below is a finding from an AI code review of `repo\/src\/calc.ts`\. Check whether/,
    );
    expect(prompt).toContain('### sub() adds instead of subtracting');
    expect(prompt).toContain('**major** · bug · `repo/src/calc.ts` lines 4–6');
    expect(prompt).toContain('Suggested fix:');
  });

  it('a review: what to do, then the findings without the details', () => {
    const prompt = reviewChatPrompt(
      { scope: 'staged changes', model: 'Stub', result: result(), findings: [finding()] },
      { filePath: (f) => `repo/${f}` },
    );
    expect(prompt).toMatch(/^Below is an AI code review of staged changes\./);
    expect(prompt).toContain('### `repo/src/calc.ts`');
    expect(prompt).not.toContain('## Details');
  });
});
