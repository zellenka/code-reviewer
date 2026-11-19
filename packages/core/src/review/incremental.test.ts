import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ReviewConfig } from '../config/schema';
import { parseUnifiedDiff } from '../diff/parse';
import { MockProvider, mockError, mockToolCall, type MockStep } from '../provider/mock';
import type { ChatRequest, ModelInfo } from '../provider/types';
import {
  createSnapshot,
  hunkHash,
  planIncremental,
  snapshotKey,
  type ReviewSnapshot,
} from './incremental';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, runReview } from './orchestrator';
import { redactFiles } from './redact';
import type { Finding } from './types';
import { fingerprint, newSideLines } from './validate';

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

describe('snapshot validity (F34)', () => {
  const diff = diffOf({ 'src/a.ts': [[1, 'old a', 'bad a1']] });
  const finding = {
    file: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    severity: 'major',
    category: 'bug',
    title: 't',
    body: 'b',
    quote: 'bad a1',
    confidence: 0.9,
  };

  it('reviews everything when high-entropy redaction was switched on', async () => {
    const r1 = await runReview(diff, {
      provider: new MockProvider({ fallback: oracle }),
      model: MODEL,
      config: DEFAULT_CONFIG,
    });
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(diff, {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      redactHighEntropy: true,
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(1);
    expect(r2.incremental).toBeUndefined();
  });

  it('reviews everything when the review prompt changed', async () => {
    const agentic: ReviewConfig = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, mode: 'agentic' },
    };
    const workspace = {
      readFile: () => Promise.resolve(''),
      grep: () => Promise.resolve([]),
      findReferences: () => Promise.resolve([]),
      getSymbolAt: () => Promise.resolve(null),
    };
    const p1 = new MockProvider({ fallback: oracle });
    const r1 = await runReview(diff, { provider: p1, model: MODEL, config: agentic, workspace });
    // The agentic prompt states the turn limit: same settings file, different prompt.
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(diff, {
      provider: p2,
      model: MODEL,
      config: agentic,
      workspace,
      agentLimits: { maxTurns: 3 },
      previous: r1.snapshot!,
    });
    expect(p2.requests).toHaveLength(1);
    expect(p2.requests[0]!.system).not.toEqual(p1.requests[0]!.system);
    expect(r2.incremental).toBeUndefined();
  });

  it('the key covers the prompts', () => {
    const parts = {
      modelId: 'm',
      config: DEFAULT_CONFIG,
      mode: 'single-pass' as const,
      context: true,
    };
    expect(snapshotKey({ ...parts, prompts: ['a'] })).not.toBe(
      snapshotKey({ ...parts, prompts: ['b'] }),
    );
  });

  it('gives no snapshot when a verify request failed', async () => {
    const provider = new MockProvider({
      script: [mockToolCall(REPORT_TOOL_NAME, { findings: [finding] }), mockError('server')],
    });
    const r = await runReview(diff, {
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      verify: true,
    });
    expect(r.verify).toMatchObject({ failed: 1 });
    expect(r.findings).toHaveLength(1);
    expect(r.snapshot).toBeUndefined();
  });

  it('gives no snapshot when a part was only partly valid', async () => {
    const bad = mockToolCall(REPORT_TOOL_NAME, {
      findings: [finding, { ...finding, confidence: 7 }],
    });
    const provider = new MockProvider({ script: [bad, bad] });
    const r = await runReview(diff, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(r.chunks.outcomes).toEqual(['partial']);
    expect(r.findings).toHaveLength(1);
    expect(r.snapshot).toBeUndefined();
  });
});

describe('incremental re-review of findings not tied to one hunk (F32)', () => {
  const lineFinding = (startLine: number, endLine: number, quote: string): Finding => ({
    id: 'x',
    file: 'src/a.ts',
    startLine,
    endLine,
    anchor: 'line',
    severity: 'major',
    category: 'bug',
    title: 't',
    body: 'b',
    quote,
    confidence: 0.9,
  });
  // Two adjacent hunks: new lines 1-3 and 4-6.
  const adjacent = (second = 'bad a2') =>
    diffOf({
      'src/a.ts': [
        [1, 'old a', 'bad a1'],
        [4, 'old b', second],
      ],
    });

  it('carries a finding across two hunks while neither changed', () => {
    const across = lineFinding(2, 5, 'bad a1\nbelow old a\nabove old b\nbad a2');
    const snapshot = createSnapshot('k', adjacent().files, [across]);
    expect(snapshot.findingHunks).toEqual([null]);

    const plan = planIncremental(adjacent(), snapshot);
    expect(plan.newHunks).toBe(0);
    expect(plan.carried).toEqual([across]);
    // One of its hunks changed: reviewed again instead.
    expect(planIncremental(adjacent('bad a2 edited'), snapshot).carried).toEqual([]);
  });

  it('carries a finding outside every hunk while nothing in its file changed', () => {
    // With the whole file known (as for a file review), code outside the hunks can be flagged.
    const withContent = (edited: string) => {
      const diff = diffOf({ 'src/a.ts': [[1, 'old a', edited]] });
      const lines = ['above old a', edited, 'below old a', '', '', 'const unused = 1;'];
      diff.files[0] = { ...diff.files[0]!, newContent: `${lines.join('\n')}\n` };
      return diff;
    };
    const outside = lineFinding(6, 6, 'const unused = 1;');
    const snapshot = createSnapshot('k', withContent('bad a1').files, [outside]);
    expect(snapshot.findingHunks).toEqual([null]);

    expect(planIncremental(withContent('bad a1'), snapshot).carried).toEqual([outside]);
    expect(planIncremental(withContent('bad a1 edited'), snapshot).carried).toEqual([]);
  });

  it('carries such a finding stored with its redacted quote, with the real code back', () => {
    const KEY = 'AKIAIOSFODNN7EXAMPLE';
    const diff = adjacent(`bad key = "${KEY}"`);
    const r = redactFiles(diff.files).files;
    const quote = `bad a1\nbelow old a\nabove old b\nbad key = "${KEY}"`;
    const redactedQuote = newSideLines(r[0]!).slice(1, 5).join('\n');
    expect(redactedQuote).not.toContain(KEY);
    const across = { ...lineFinding(2, 5, quote), redactedQuote };
    const snapshot = createSnapshot('k', r, [across]);
    expect(JSON.stringify(snapshot)).not.toContain(KEY);

    expect(planIncremental(diff, snapshot).carried).toEqual([across]);
  });
});

describe('incremental re-review of findings on redacted secrets (F33)', () => {
  const KEY = 'AKIAIOSFODNN7EXAMPLE';
  const withKey = (key: string, other = 'bad a1') =>
    diffOf({
      'src/k.ts': [
        [1, 'old k', `bad key = "${key}"`],
        [20, 'old a', other],
      ],
    });
  /** A snapshot as the host keeps it: written to storage as JSON and read back. */
  const stored = (snapshot: unknown) => JSON.parse(JSON.stringify(snapshot)) as ReviewSnapshot;

  it('keeps the secret and hashes of it out of the snapshot', async () => {
    const diff = withKey(KEY);
    const r1 = await runReview(diff, {
      provider: new MockProvider({ fallback: oracle }),
      model: MODEL,
      config: DEFAULT_CONFIG,
    });
    const secret = r1.findings.find((f) => f.startLine === 2)!;
    expect(secret.quote).toBe(`bad key = "${KEY}"`);
    const json = JSON.stringify(r1.snapshot);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain(fingerprint('src/k.ts', 'bug', secret.quote));
    expect(json).not.toContain(hunkHash('src/k.ts', diff.files[0]!.hunks[0]!));
    // The other hunk has no secret: same hash as before, so older snapshots still match.
    expect(r1.snapshot!.hunks['src/k.ts']).toContain(
      hunkHash('src/k.ts', diff.files[0]!.hunks[1]!),
    );
  });

  it('carries the finding over with its real code, from a stored snapshot', async () => {
    const r1 = await runReview(withKey(KEY), {
      provider: new MockProvider({ fallback: oracle }),
      model: MODEL,
      config: DEFAULT_CONFIG,
    });
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(withKey(KEY), {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      previous: stored(r1.snapshot),
    });
    expect(p2.requests).toHaveLength(0);
    expect(r2.incremental).toEqual({ newHunks: 0, reusedHunks: 2, carried: 2 });
    expect(r2.findings).toEqual(r1.findings);
    expect(JSON.stringify(r2.snapshot)).not.toContain(KEY);

    // Only the other hunk changed: the secret finding is still carried, the new one sent.
    const p3 = new MockProvider({ fallback: oracle });
    const r3 = await runReview(withKey(KEY, 'bad a1 edited'), {
      provider: p3,
      model: MODEL,
      config: DEFAULT_CONFIG,
      previous: stored(r2.snapshot),
    });
    expect(sentText(p3)).not.toContain('bad key');
    expect(r3.findings.map((f) => f.quote)).toEqual([`bad key = "${KEY}"`, 'bad a1 edited']);
  });

  it('reports on the whole diff, but counts the redactions of the new hunks only', async () => {
    const diff = (other: string) => ({
      files: [...withKey(KEY, other).files, ...diffOf({ '.env': [[1, 'A=1', 'A=2']] }).files],
    });
    const r1 = await runReview(diff('bad a1'), {
      provider: new MockProvider({ fallback: oracle }),
      model: MODEL,
      config: DEFAULT_CONFIG,
    });
    expect(r1.redactions).toBe(1);
    const p2 = new MockProvider({ fallback: oracle });
    const r2 = await runReview(diff('bad a1 edited'), {
      provider: p2,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
      previous: stored(r1.snapshot),
    });
    expect(r2.redactions).toBe(0);
    expect(r2.reviewedFiles).toEqual(['src/k.ts']);
    expect(r2.skipped).toEqual([{ path: '.env', reason: 'secret' }]);
    expect(r2.snapshot!.hunks['src/k.ts']).toHaveLength(2);
    expect(r2.snapshot!.findings).toHaveLength(2);
    // The summary is of the whole change, redacted.
    expect(p2.requests).toHaveLength(2);
    const summary = JSON.stringify(p2.requests[1]!.messages);
    expect(summary).toContain('bad key = \\"[REDACTED:aws-access-key]\\"');
    expect(summary).toContain('bad a1 edited');
    expect(summary).not.toContain(KEY);
    // The estimate counts only the files with new hunks (none of them skipped).
    expect(
      estimateReview(diff('bad a1 edited'), {
        model: MODEL,
        config: DEFAULT_CONFIG,
        summary: true,
        previous: stored(r1.snapshot),
      }),
    ).toMatchObject({ files: 1, skipped: 0, requests: 2 });
  });

  it('a new finding with the same redacted code on another line does not replace a carried one', async () => {
    const r1 = await runReview(withKey(KEY), {
      provider: new MockProvider({ fallback: oracle }),
      model: MODEL,
      config: DEFAULT_CONFIG,
    });
    const other = 'AKIAI44QH8DHBEXAMPLE';
    const r2 = await runReview(withKey(KEY, `bad key = "${other}"`), {
      provider: new MockProvider({ fallback: oracle }),
      model: MODEL,
      config: DEFAULT_CONFIG,
      previous: stored(r1.snapshot),
    });
    expect(r2.findings.map((f) => f.quote)).toEqual([`bad key = "${KEY}"`, `bad key = "${other}"`]);
  });
});
