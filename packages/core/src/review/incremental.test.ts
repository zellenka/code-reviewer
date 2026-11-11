import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { parseUnifiedDiff } from '../diff/parse';
import { MockProvider, mockToolCall, type MockStep } from '../provider/mock';
import type { ChatRequest, ModelInfo } from '../provider/types';
import { hunkHash, planIncremental } from './incremental';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, runReview } from './orchestrator';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
};

/** Unified diff of one file; each hunk is [newStart, removed line, added line]. */
function diffOf(files: Record<string, [number, string, string][]>) {
  const text = Object.entries(files)
    .map(([path, hunks]) => {
      const body = hunks
        .map(
          ([start, del, add]) =>
            `@@ -${start},3 +${start},3 @@\n above ${del}\n-${del}\n+${add}\n below ${del}`,
        )
        .join('\n');
      return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
    })
    .join('\n');
  return parseUnifiedDiff(`${text}\n`);
}

/** Reports a bug on every added line it is shown that starts with "bad". */
function oracle(req: ChatRequest): MockStep {
  if (!req.tools) return { events: [{ type: 'text', delta: 'summary' }] };
  const text = req.messages
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
  const findings = [...text.matchAll(/<file path="([^"]+)"[\s\S]*?<\/file>/g)].flatMap(
    ([block, file]) =>
      [...block!.matchAll(/^\s*(\d+) \+ (bad.*)$/gm)].map(([, line, code]) => ({
        file,
        startLine: Number(line),
        endLine: Number(line),
        severity: 'major',
        category: 'bug',
        title: `Bad: ${code}`,
        body: 'b',
        quote: code,
        confidence: 0.9,
      })),
  );
  return mockToolCall(REPORT_TOOL_NAME, { findings });
}

const sentText = (p: MockProvider) => JSON.stringify(p.requests.map((r) => r.messages));

describe('incremental re-review', () => {
  const first = diffOf({
    'src/a.ts': [
      [1, 'old a', 'bad a1'],
      [20, 'old b', 'bad a2'],
    ],
    'src/b.ts': [[5, 'old c', 'bad b1']],
  });

  it('re-review after a one-line edit sends only the changed hunk and keeps the rest', async () => {
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(first, { provider: p1, model: MODEL, config: DEFAULT_CONFIG });
    expect(r1.findings).toHaveLength(3);
    expect(r1.snapshot?.hunks['src/a.ts']).toHaveLength(2);

    // One line edited in the second hunk of a.ts.
    const second = diffOf({
      'src/a.ts': [
        [1, 'old a', 'bad a1'],
        [20, 'old b', 'bad a2 edited'],
      ],
      'src/b.ts': [[5, 'old c', 'bad b1']],
    });
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(second, {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(1);
    expect(r2.chunks.total).toBe(1);
    const sent = sentText(p2);
    expect(sent).toContain('bad a2 edited');
    expect(sent).not.toContain('bad a1');
    expect(sent).not.toContain('bad b1');
    expect(r2.incremental).toEqual({ newHunks: 1, reusedHunks: 2, carried: 2 });
    expect(r2.findings.map((f) => f.title).sort()).toEqual([
      'Bad: bad a1',
      'Bad: bad a2 edited',
      'Bad: bad b1',
    ]);
    expect(r2.reviewedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r2.snapshot?.findings).toHaveLength(3);
  });

  it('sends nothing when nothing changed and reuses the summary', async () => {
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(first, {
      provider: p1,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
    });
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(first, {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(0);
    expect(r2.findings).toEqual(r1.findings);
    expect(r2.summary).toBe('summary');
    expect(
      estimateReview(first, { model: MODEL, config: DEFAULT_CONFIG, previous: r1.snapshot! })
        .requests,
    ).toBe(0);
  });

  it('does not count ignored files as new', async () => {
    const withSecret = diffOf({
      'src/a.ts': [[1, 'old a', 'bad a1']],
      '.env': [[1, 'TOKEN=1', 'TOKEN=2']],
    });
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(withSecret, { provider: p1, model: MODEL, config: DEFAULT_CONFIG });
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(withSecret, {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(0);
    expect(r2.incremental).toEqual({ newHunks: 0, reusedHunks: 1, carried: 1 });
    expect(r2.skipped).toEqual([{ path: '.env', reason: 'secret' }]);
  });

  it('moves carried findings with their hunk', () => {
    const r1Findings = [
      {
        id: 'x',
        file: 'src/a.ts',
        startLine: 21,
        endLine: 21,
        anchor: 'line' as const,
        severity: 'major' as const,
        category: 'bug' as const,
        title: 't',
        body: 'b',
        quote: 'bad a2',
        confidence: 0.9,
      },
    ];
    const hunk = first.files[0]!.hunks[1]!;
    const moved = diffOf({
      'src/a.ts': [
        [1, 'old a', 'bad a1 new'],
        [24, 'old b', 'bad a2'],
      ],
    });
    expect(hunkHash('src/a.ts', moved.files[0]!.hunks[1]!)).toBe(hunkHash('src/a.ts', hunk));
    const plan = planIncremental(moved, {
      version: 1,
      key: 'k',
      hunks: { 'src/a.ts': [hunkHash('src/a.ts', hunk)] },
      findings: r1Findings,
      findingHunks: [hunkHash('src/a.ts', hunk)],
    });
    expect(plan.carried).toEqual([{ ...r1Findings[0], startLine: 25, endLine: 25 }]);
    expect(plan.diff.files[0]!.hunks).toHaveLength(1);
  });

  it('drops findings whose hunk changed or whose file is gone', () => {
    const plan = planIncremental(diffOf({ 'src/a.ts': [[20, 'old b', 'bad a2 v2']] }), {
      version: 1,
      key: 'k',
      hunks: { 'src/a.ts': ['nope'], 'src/b.ts': ['nope'] },
      findingHunks: ['nope', 'nope'],
      findings: [
        {
          id: '1',
          file: 'src/a.ts',
          startLine: 21,
          endLine: 21,
          anchor: 'line',
          severity: 'major',
          category: 'bug',
          title: 't',
          body: '',
          quote: 'bad a2',
          confidence: 1,
        },
        {
          id: '2',
          file: 'src/b.ts',
          startLine: 6,
          endLine: 6,
          anchor: 'line',
          severity: 'major',
          category: 'bug',
          title: 't',
          body: '',
          quote: 'bad b1',
          confidence: 1,
        },
      ],
    });
    expect(plan.carried).toEqual([]);
    expect(plan.newHunks).toBe(1);
  });

  it('does not move a finding of an edited hunk onto an unchanged one with the same code', async () => {
    const twice = diffOf({
      'src/a.ts': [
        [1, 'old a', 'bad same'],
        [20, 'old b', 'bad same'],
      ],
    });
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(twice, { provider: p1, model: MODEL, config: DEFAULT_CONFIG });
    // Both lines share a fingerprint; keep only the one on line 2 (as if the other were dropped).
    const snapshot = { ...r1.snapshot! };
    const keep = snapshot.findings.findIndex((f) => f.startLine === 2);
    snapshot.findings = [snapshot.findings[keep]!];
    snapshot.findingHunks = [snapshot.findingHunks[keep]!];

    const edited = diffOf({
      'src/a.ts': [
        [1, 'old a', 'fine now'],
        [20, 'old b', 'bad same'],
      ],
    });
    const plan = planIncremental(edited, snapshot);
    expect(plan.carried).toEqual([]);
    expect(plan.newHunks).toBe(1);
  });

  it('writes a summary when it was just turned on and nothing changed', async () => {
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(first, { provider: p1, model: MODEL, config: DEFAULT_CONFIG });
    expect(r1.summary).toBeUndefined();
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(first, {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(1);
    expect(r2.summary).toBe('summary');
    expect(r2.snapshot?.summary).toBe('summary');
  });

  it('reviews everything when the model or config changed', async () => {
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(first, { provider: p1, model: MODEL, config: DEFAULT_CONFIG });
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(first, {
      provider: p2,
      model: MODEL,
      config: { ...DEFAULT_CONFIG, severityThreshold: 'major' },
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(1);
    expect(r2.incremental).toBeUndefined();
  });

  it('gives no snapshot when a part failed, so the next review starts over', async () => {
    const provider = new MockProvider({
      script: [
        { events: [{ type: 'text', delta: 'no tool' }] },
        { events: [{ type: 'text', delta: 'still none' }] },
      ],
    });
    const r = await runReview(first, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(r.chunks.failed).toBe(1);
    expect(r.snapshot).toBeUndefined();
  });
});
