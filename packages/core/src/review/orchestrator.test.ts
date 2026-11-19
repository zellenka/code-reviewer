import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { addedFileDiff, parseUnifiedDiff } from '../diff/parse';
import type { UnifiedDiff } from '../diff/types';
import { MockProvider, mockError, mockText, mockToolCall, type MockStep } from '../provider/mock';
import type { ChatRequest, ModelInfo } from '../provider/types';
import { estimateTokens } from '../provider/usage';
import { ReviewTooLargeError, chunkFiles, renderChunk } from './chunker';
import { noopLogger } from '../logger';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, runReview, type ReviewProgress } from './orchestrator';
import { reviewChunk } from './reviewer';
import { fingerprint } from './validate';
import { VERIFY_TOOL_NAME } from './verify';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
};

const finding = (over: Record<string, unknown> = {}) => ({
  file: 'src/a.ts',
  startLine: 2,
  endLine: 2,
  severity: 'major',
  category: 'bug',
  title: 'Wrong operator',
  body: 'Should be `-`.',
  quote: 'return a + b;',
  confidence: 0.9,
  ...over,
});

const report = (findings: unknown[]) => mockToolCall(REPORT_TOOL_NAME, { findings });

const SAMPLE: UnifiedDiff = {
  files: [addedFileDiff('src/a.ts', 'export function sub(a, b) {\n  return a + b;\n}\n')],
};

/** Everything the provider saw, as one string. */
const sent = (p: MockProvider) => JSON.stringify(p.requests);

function requestTokens(req: ChatRequest): number {
  return estimateTokens(
    req.system.map((s) => s.text).join('') +
      JSON.stringify(req.messages) +
      JSON.stringify(req.tools ?? []),
  );
}

describe('reviewChunk (structured output)', () => {
  const base = { model: MODEL, config: DEFAULT_CONFIG, diff: 'x', maxOutputTokens: 1000 };
  const signal = new AbortController().signal;

  it('forces report_findings and accepts valid input first time', async () => {
    const provider = new MockProvider({ script: [report([finding()])] });
    const result = await reviewChunk({ ...base, provider, signal });
    expect(result.outcome).toBe('valid');
    expect(result.findings).toHaveLength(1);
    expect(provider.requests[0]!.toolChoice).toEqual({ name: REPORT_TOOL_NAME });
    expect(provider.requests[0]!.system[0]!.text).toMatch(/untrusted data/);
  });

  it('repairs invalid tool input once, answering the tool call with an error', async () => {
    const provider = new MockProvider({
      script: [report([finding({ severity: 'urgent' })]), report([finding()])],
    });
    const result = await reviewChunk({ ...base, provider, signal });
    expect(result.outcome).toBe('repaired');
    expect(result.findings).toHaveLength(1);
    const repair = provider.requests[1]!.messages;
    expect(repair).toHaveLength(3);
    const toolResult = repair[2]!.content[0]!;
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
    expect(JSON.stringify(toolResult)).toMatch(/severity/);
  });

  it('repairs when the model answers in prose without a tool call', async () => {
    const provider = new MockProvider({
      script: [mockText('Looks good to me!'), report([])],
    });
    const result = await reviewChunk({ ...base, provider, signal });
    expect(result.outcome).toBe('repaired');
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toMatch(/must call/);
  });

  it('asks for a shorter answer when the output limit cut it off', async () => {
    const cut: MockStep = {
      events: [
        { type: 'text', delta: '{"findings": [{"file": "src/a.ts", "body": "Long' },
        { type: 'stop', reason: 'max_tokens' },
      ],
    };
    const provider = new MockProvider({ script: [cut, report([])] });
    const result = await reviewChunk({ ...base, provider, signal });
    expect(result.outcome).toBe('repaired');
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toMatch(/cut off.*fewer/);
  });

  it('treats unfinished JSON as possibly cut off when the provider cannot tell (vscode.lm)', async () => {
    // Copilot ends every answer with stop: end, even one cut off by the output limit.
    const provider = new MockProvider({
      script: [mockText('```json\n{"findings": [{"file": "src/a.ts", "body": "Long'), report([])],
    });
    const result = await reviewChunk({ ...base, provider, signal });
    expect(result.outcome).toBe('repaired');
    const repair = JSON.stringify(provider.requests[1]!.messages.at(-1));
    expect(repair).toMatch(/cut off/);
    expect(repair).toMatch(/fewer findings with shorter bodies/);
    expect(repair).toMatch(new RegExp(REPORT_TOOL_NAME));
  });

  it('does not suggest a cut-off for a finished prose answer', async () => {
    const provider = new MockProvider({ script: [mockText('All fine [no issues].'), report([])] });
    await reviewChunk({ ...base, provider, signal });
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).not.toMatch(/cut off/);
  });

  it('accepts JSON in text, and uses JSON-only mode for models without tools', async () => {
    const fenced = mockText('```json\n' + JSON.stringify({ findings: [finding()] }) + '\n```');
    const provider = new MockProvider({ script: [fenced, fenced] });
    expect((await reviewChunk({ ...base, provider, signal })).outcome).toBe('valid');

    const noTools = { ...MODEL, supportsTools: false };
    const result = await reviewChunk({ ...base, model: noTools, provider, signal });
    expect(result.findings).toHaveLength(1);
    expect(provider.requests[1]!.tools).toBeUndefined();
    expect(provider.requests[1]!.system[0]!.text).toMatch(/```json/);
  });

  it('keeps valid items when repair also fails, and fails cleanly on junk', async () => {
    const bad = report([finding(), finding({ confidence: 7 })]);
    const partial = await reviewChunk({
      ...base,
      provider: new MockProvider({ script: [bad, bad] }),
      signal,
    });
    expect(partial).toMatchObject({ outcome: 'partial', invalid: 1 });
    expect(partial.findings).toHaveLength(1);

    const failed = await reviewChunk({
      ...base,
      provider: new MockProvider({ script: [mockText('no'), mockText('still no')] }),
      signal,
    });
    expect(failed).toMatchObject({ outcome: 'failed', findings: [] });
  });
});

describe('chunker + token budget', () => {
  // 5k changed lines over 25 files, plus one 2k-line file with a single huge hunk.
  const bigDiff = (): UnifiedDiff => {
    const files = Array.from({ length: 25 }, (_, f) =>
      addedFileDiff(
        `src/file${f}.ts`,
        Array.from(
          { length: 200 },
          (_, i) => `export const value${i} = compute(${i}, "${f}");`,
        ).join('\n'),
      ),
    );
    files.push(
      addedFileDiff(
        'src/huge.ts',
        Array.from({ length: 2000 }, (_, i) => `  total += lookup(table, ${i}) * factor;`).join(
          '\n',
        ),
      ),
    );
    return { files };
  };

  it('no request exceeds the model input limit on a 5k+ line diff', async () => {
    const small: ModelInfo = { ...MODEL, maxInputTokens: 16_000, maxOutputTokens: 2_000 };
    const provider = new MockProvider({ fallback: report([]) });
    const result = await runReview(bigDiff(), { provider, model: small, config: DEFAULT_CONFIG });
    expect(result.chunks.total).toBeGreaterThan(5);
    expect(result.chunks.completed).toBe(result.chunks.total);
    for (const req of provider.requests) {
      expect(requestTokens(req) + (req.maxOutputTokens ?? 0)).toBeLessThanOrEqual(
        small.maxInputTokens,
      );
    }
    // Every changed line was sent exactly once.
    const all = provider.requests.map((r) => JSON.stringify(r.messages)).join('');
    expect(all.match(/lookup\(table, 1999\)/g)).toHaveLength(1);
    expect(all.match(/value199 = compute\(199, \\"24\\"\)/g)).toHaveLength(1);
  });

  it('split parts keep correct new-side line numbers', () => {
    const chunks = chunkFiles(bigDiff().files.slice(-1), { maxTokens: 2000 });
    expect(chunks.length).toBeGreaterThan(3);
    const rendered = chunks.map(renderChunk);
    expect(rendered[1]).toMatch(/part="2\/\d+"/);
    const firstLineOfPart2 = /\n\s+(\d+) \+/.exec(rendered[1]!)![1];
    const lastLineOfPart1 = [...rendered[0]!.matchAll(/\n\s+(\d+) \+/g)].at(-1)![1];
    expect(Number(firstLineOfPart2)).toBe(Number(lastLineOfPart1) + 1);
  });

  it('merges small files into one request', () => {
    const files = ['a', 'b', 'c'].map((n) => addedFileDiff(`${n}.ts`, 'x\n'));
    expect(chunkFiles(files, { maxTokens: 5000 })).toHaveLength(1);
  });

  it('rejects a model whose input limit leaves no room for the diff', async () => {
    const provider = new MockProvider({ fallback: report([]) });
    await expect(
      runReview(SAMPLE, {
        provider,
        model: { ...MODEL, maxInputTokens: 2_000, maxOutputTokens: 1_000 },
        config: DEFAULT_CONFIG,
      }),
    ).rejects.toThrow(/too small an input limit/);
    expect(provider.requests).toHaveLength(0);
  });

  it.each([
    ['NaN input limit', { maxInputTokens: Number.NaN }],
    ['string input limit', { maxInputTokens: '200k' as unknown as number }],
    ['NaN output limit', { maxOutputTokens: Number.NaN }],
  ])('rejects a model with a %s instead of sending one unbounded request', async (_l, over) => {
    const provider = new MockProvider({ fallback: report([]) });
    await expect(
      runReview(bigDiff(), { provider, model: { ...MODEL, ...over }, config: DEFAULT_CONFIG }),
    ).rejects.toThrow(/invalid token limit/);
    expect(provider.requests).toHaveLength(0);
  });

  it('chunkFiles refuses a non-finite token budget', () => {
    const files = bigDiff().files.slice(-1);
    expect(() => chunkFiles(files, { maxTokens: Number.NaN })).toThrow(RangeError);
    expect(() => chunkFiles(files, { maxTokens: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('too many parts gives a "narrow the scope" error', async () => {
    const provider = new MockProvider({ fallback: report([]) });
    await expect(
      runReview(bigDiff(), {
        provider,
        model: { ...MODEL, maxInputTokens: 12_000 },
        config: DEFAULT_CONFIG,
        maxChunks: 3,
      }),
    ).rejects.toBeInstanceOf(ReviewTooLargeError);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('runReview', () => {
  it('aggregates findings, usage and outcomes', async () => {
    const provider = new MockProvider({
      script: [report([finding(), finding({ category: 'style' })])],
    });
    const result = await runReview(SAMPLE, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'src/a.ts', startLine: 2, severity: 'major' });
    expect(result.dropped).toEqual([{ reason: 'categoryDisabled', count: 1 }]);
    expect(result.usage.requests).toBe(1);
    expect(result.chunks).toMatchObject({ total: 1, completed: 1, failed: 0, outcomes: ['valid'] });
    expect(result.reviewedFiles).toEqual(['src/a.ts']);
  });

  it('ignored files and secrets never reach the provider', async () => {
    const diff: UnifiedDiff = {
      files: [
        addedFileDiff('.env', 'DB_PASSWORD=supersecretvalue\n'),
        addedFileDiff('config/prod.pem', '-----BEGIN PRIVATE KEY-----\nMIIabc\n'),
        addedFileDiff('pnpm-lock.yaml', 'lockfileVersion: 9\nUNIQUE_LOCK_MARKER\n'),
        addedFileDiff('gen/api.ts', 'UNIQUE_IGNORED_MARKER\n'),
        addedFileDiff(
          'src/aws.ts',
          'export const key = "AKIAIOSFODNN7EXAMPLE";\nexport const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";\n',
        ),
      ],
    };
    const config = { ...DEFAULT_CONFIG, ignore: ['gen/'] };
    const provider = new MockProvider({ fallback: report([]) });
    const result = await runReview(diff, { provider, model: MODEL, config });
    const payload = sent(provider);
    for (const secret of [
      'supersecretvalue',
      'MIIabc',
      'UNIQUE_LOCK_MARKER',
      'UNIQUE_IGNORED_MARKER',
      'AKIAIOSFODNN7EXAMPLE',
      'wJalrXUtnFEMI',
      '.env',
      'prod.pem',
    ]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain('src/aws.ts');
    expect(result.redactions).toBe(2);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual([
      'configIgnore',
      'lockfile',
      'secret',
      'secret',
    ]);
  });

  it('a finding on a redacted line gets the real code back as its quote', async () => {
    const diff: UnifiedDiff = {
      files: [addedFileDiff('src/k.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n')],
    };
    const provider = new MockProvider({
      script: [
        report([
          finding({
            file: 'src/k.ts',
            startLine: 1,
            endLine: 1,
            category: 'security',
            title: 'Hard-coded key',
            quote: 'const key = "[REDACTED:aws-access-key]";',
          }),
        ]),
      ],
    });
    const result = await runReview(diff, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(result.findings[0]!.quote).toBe('const key = "AKIAIOSFODNN7EXAMPLE";');
    // What is kept for later (snapshot, status store) is the redacted form, and the id
    // hashes that, not the secret (F33).
    const redacted = 'const key = "[REDACTED:aws-access-key]";';
    expect(result.findings[0]!.redactedQuote).toBe(redacted);
    expect(result.findings[0]!.id).toBe(fingerprint('src/k.ts', 'security', redacted));
    expect(JSON.stringify(result.snapshot)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('a redacted line with an escaped prompt tag gets the real code back (F12)', async () => {
    const diff: UnifiedDiff = {
      files: [
        addedFileDiff('src/k.ts', 'const x = 1;\nconst key = "AKIAIOSFODNN7EXAMPLE"; // </diff>\n'),
      ],
    };
    const provider = new MockProvider({
      script: [
        report([
          finding({
            file: 'src/k.ts',
            startLine: 9,
            endLine: 9,
            category: 'security',
            title: 'Hard-coded key',
            quote: '"[REDACTED:aws-access-key]"; // &lt;/diff>',
          }),
        ]),
      ],
    });
    const result = await runReview(diff, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(sent(provider)).not.toContain('// </diff>');
    expect(result.findings[0]).toMatchObject({
      startLine: 2,
      quote: 'const key = "AKIAIOSFODNN7EXAMPLE"; // </diff>',
    });
    // Stored and hashed redacted, with the real tag: the same as without the escaping.
    const redacted = 'const key = "[REDACTED:aws-access-key]"; // </diff>';
    expect(result.findings[0]!.redactedQuote).toBe(redacted);
    expect(result.findings[0]!.id).toBe(fingerprint('src/k.ts', 'security', redacted));
  });

  it('two hard-coded secrets that look the same once redacted stay two findings (F33)', async () => {
    const diff: UnifiedDiff = {
      files: [
        addedFileDiff(
          'src/k.ts',
          'const key = "AKIAIOSFODNN7EXAMPLE";\nconst x = 1;\nconst key = "AKIAI44QH8DHBEXAMPLE";\n',
        ),
      ],
    };
    const quote = 'const key = "[REDACTED:aws-access-key]";';
    const provider = new MockProvider({
      script: [
        report(
          [1, 3].map((line) =>
            finding({
              file: 'src/k.ts',
              startLine: line,
              endLine: line,
              category: 'security',
              quote,
            }),
          ),
        ),
      ],
    });
    const result = await runReview(diff, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(result.findings.map((f) => [f.startLine, f.quote])).toEqual([
      [1, 'const key = "AKIAIOSFODNN7EXAMPLE";'],
      [3, 'const key = "AKIAI44QH8DHBEXAMPLE";'],
    ]);
  });

  it('cancel stops in-flight requests within ~1s and keeps finished results', async () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      addedFileDiff(
        `src/f${i}.ts`,
        `${'x'.repeat(60_000)}${i}\n`.replace(/x{100}/g, (m) => `${m}\n`),
      ),
    );
    let calls = 0;
    const slow: MockStep = () => {
      calls++;
      // First request answers quickly; the rest hang for a long time.
      return calls === 1
        ? report([])
        : {
            events: [
              { type: 'text', delta: 'thinking…' },
              { type: 'text', delta: 'x' },
            ],
            delayMs: 30_000,
          };
    };
    const provider = new MockProvider({ fallback: slow });
    const controller = new AbortController();
    const model = { ...MODEL, maxInputTokens: 30_000 };
    const started = Date.now();
    const promise = runReview(
      { files },
      { provider, model, config: DEFAULT_CONFIG, concurrency: 2, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.cancelled).toBe(true);
    expect(result.chunks.completed).toBe(1);
    expect(result.chunks.outcomes.filter((o) => o === 'cancelled').length).toBeGreaterThan(0);
    // No new requests started after the abort.
    expect(provider.requests.length).toBeLessThanOrEqual(3);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const provider = new MockProvider({
      fallback: () => {
        active++;
        peak = Math.max(peak, active);
        setTimeout(() => active--, 20);
        return { ...report([]), delayMs: 20 } as MockStep;
      },
    });
    const files = Array.from({ length: 8 }, (_, i) =>
      addedFileDiff(`f${i}.ts`, 'y\n'.repeat(3000)),
    );
    await runReview(
      { files },
      {
        provider,
        model: { ...MODEL, maxInputTokens: 12_000 },
        config: DEFAULT_CONFIG,
        concurrency: 3,
      },
    );
    expect(provider.requests.length).toBeGreaterThan(3);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('an auth error stops the review; other errors only fail their part', async () => {
    const files = Array.from({ length: 4 }, (_, i) =>
      addedFileDiff(`f${i}.ts`, 'z\n'.repeat(3000)),
    );
    const model = { ...MODEL, maxInputTokens: 12_000 };
    await expect(
      runReview(
        { files },
        {
          provider: new MockProvider({ fallback: mockError('auth', 'bad key') }),
          model,
          config: DEFAULT_CONFIG,
          concurrency: 1,
        },
      ),
    ).rejects.toMatchObject({ kind: 'auth' });

    const provider = new MockProvider({
      script: [mockError('contextTooLong', 'too long')],
      fallback: report([]),
    });
    const result = await runReview(
      { files },
      { provider, model, config: DEFAULT_CONFIG, concurrency: 1 },
    );
    expect(result.chunks.failed).toBe(1);
    expect(result.chunks.completed).toBe(result.chunks.total - 1);
    expect(result.errors[0]).toMatch(/too long/);
  });

  it('a blocked part fails alone and keeps the findings of the other parts', async () => {
    const files = Array.from({ length: 3 }, (_, i) =>
      addedFileDiff(`f${i}.ts`, 'z\n'.repeat(3000)),
    );
    const provider = new MockProvider({
      script: [
        mockError('blocked', 'filtered'),
        report([finding({ file: 'f1.ts', quote: 'z', startLine: 2, endLine: 2 })]),
      ],
      fallback: report([]),
    });
    const result = await runReview(
      { files },
      {
        provider,
        model: { ...MODEL, maxInputTokens: 12_000 },
        config: DEFAULT_CONFIG,
        concurrency: 1,
      },
    );
    expect(result.chunks.total).toBeGreaterThan(2);
    expect(result.chunks.failed).toBe(1);
    expect(result.chunks.completed).toBe(result.chunks.total - 1);
    expect(result.errors).toEqual(['Part 1: filtered']);
    expect(result.findings.map((f) => f.file)).toEqual(['f1.ts']);
  });

  it('counts the usage of a part that failed after its first request (F15)', async () => {
    const files = Array.from({ length: 3 }, (_, i) =>
      addedFileDiff(`f${i}.ts`, 'z\n'.repeat(3000)),
    );
    // Part 1 answers without the tool, then its repair request fails.
    const provider = new MockProvider({
      script: [mockText('no tool'), mockError('server', 'overloaded')],
      fallback: report([]),
    });
    const result = await runReview(
      { files },
      {
        provider,
        model: { ...MODEL, maxInputTokens: 12_000 },
        config: DEFAULT_CONFIG,
        concurrency: 1,
      },
    );
    expect(result.chunks.failed).toBe(1);
    expect(result.errors).toEqual(['Part 1: overloaded']);
    // Every request but the failed one was answered (and billed).
    expect(result.usage.requests).toBe(provider.requests.length - 1);
  });

  it('an empty diff makes no requests', async () => {
    const provider = new MockProvider();
    const result = await runReview(parseUnifiedDiff(''), {
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
    });
    expect(result.chunks.total).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('runReview scheduling and post-processing', () => {
  const parts = (n: number) =>
    Array.from({ length: n }, (_, i) => addedFileDiff(`f${i}.ts`, 'z\n'.repeat(3000)));
  const small = { ...MODEL, maxInputTokens: 12_000 };
  const cached = { ...small, promptCaching: { minTokens: 1 } };

  it('reports progress per part, then the verify and summary phases', async () => {
    const provider = new MockProvider({
      script: [
        report([finding()]),
        mockToolCall(VERIFY_TOOL_NAME, { verdicts: [{ id: 'F1', real: true, reason: 'r' }] }),
        mockText('walkthrough'),
      ],
    });
    const progress: ReviewProgress[] = [];
    const result = await runReview(SAMPLE, {
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      verify: true,
      summary: true,
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(progress).toEqual([
      { chunksTotal: 1, chunksDone: 0, findings: 0 },
      { chunksTotal: 1, chunksDone: 1, findings: 1 },
      { chunksTotal: 1, chunksDone: 1, findings: 1, phase: 'verify' },
      { chunksTotal: 1, chunksDone: 1, findings: 1, phase: 'summary' },
    ]);
    expect(result.verify).toEqual({ checked: 1, rejected: 0, failed: 0 });
    expect(result.summary).toBe('walkthrough');
    // Review, verify and summary requests are all counted.
    expect(provider.requests).toHaveLength(3);
    expect(result.usage.requests).toBe(3);
    expect(result.snapshot?.summary).toBe('walkthrough');
  });

  it('throws the first error when every part failed', async () => {
    const provider = new MockProvider({
      script: [mockError('server', 'first')],
      fallback: mockError('server', 'later'),
    });
    await expect(
      runReview(
        { files: parts(2) },
        { provider, model: small, config: DEFAULT_CONFIG, concurrency: 1 },
      ),
    ).rejects.toMatchObject({ kind: 'server', message: 'first' });
  });

  it('a part without usable findings fails with a note instead of throwing', async () => {
    const provider = new MockProvider({ script: [mockText('no'), mockText('still no')] });
    const result = await runReview(SAMPLE, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(result.chunks).toEqual({ total: 1, completed: 0, failed: 1, outcomes: ['failed'] });
    expect(result.errors).toEqual(['Part 1: the model returned no usable findings.']);
    expect(result.snapshot).toBeUndefined();
  });

  it('a review cancelled before it starts sends nothing and marks every part cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new MockProvider({ fallback: report([]) });
    const result = await runReview(
      { files: parts(3) },
      { provider, model: small, config: DEFAULT_CONFIG, signal: controller.signal, summary: true },
    );
    expect(provider.requests).toHaveLength(0);
    expect(result.cancelled).toBe(true);
    expect(result.chunks.total).toBeGreaterThan(1);
    expect(result.chunks.outcomes).toEqual(Array(result.chunks.total).fill('cancelled'));
    expect(result.summary).toBeUndefined();
    expect(result.snapshot).toBeUndefined();
  });

  it('a failed first part still lets the others start while warming the cache', async () => {
    const provider = new MockProvider({
      script: [mockError('server', 'down')],
      fallback: report([]),
    });
    const result = await runReview(
      { files: parts(3) },
      { provider, model: cached, config: DEFAULT_CONFIG, concurrency: 3 },
    );
    expect(result.chunks.failed).toBe(1);
    expect(result.chunks.completed).toBe(result.chunks.total - 1);
    expect(result.chunks.outcomes[0]).toBe('failed');
    expect(result.errors).toEqual(['Part 1: down']);
  });

  it('a fatal error in the first part fails the review while warming the cache', async () => {
    const provider = new MockProvider({
      script: [mockError('auth', 'bad key')],
      fallback: report([]),
    });
    const result = runReview(
      { files: parts(3) },
      { provider, model: cached, config: DEFAULT_CONFIG, concurrency: 3 },
    );
    await expect(result).rejects.toMatchObject({ kind: 'auth' });
    // The waiting parts are released as the first one ends, just before it aborts them.
    expect(provider.requests.length).toBeLessThanOrEqual(3);
  });

  it('logs what it sends', async () => {
    const logs: string[] = [];
    const logger = {
      ...noopLogger,
      info: (m: string) => logs.push(`info: ${m}`),
      warn: (m: string) => logs.push(`warn: ${m}`),
    };
    const diff: UnifiedDiff = {
      files: [
        addedFileDiff('src/k.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n'),
        addedFileDiff('.env', 'TOKEN=1\n'),
      ],
    };
    const agentic = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, mode: 'agentic' } };
    await runReview(diff, {
      provider: new MockProvider({ fallback: report([]) }),
      model: MODEL,
      config: agentic as typeof DEFAULT_CONFIG,
      logger,
    });
    expect(logs).toMatchInlineSnapshot(`
      [
        "warn: agentic review needs repository access here; running single-pass",
        "info: redacted 1 secret(s) before sending",
        "info: reviewing 1 file(s) in 1 request(s) with m (single-pass); skipped 1",
        "info: review done: 0 finding(s), 0 failed part(s)",
      ]
    `);
  });
});

describe('estimateReview numbers', () => {
  const files = Array.from({ length: 6 }, (_, i) =>
    addedFileDiff(
      `src/f${i}.ts`,
      Array.from({ length: 300 }, (_, n) => `export const v${i}_${n} = compute(${n}, 'x');\n`).join(
        '',
      ),
    ),
  );
  const diff: UnifiedDiff = { files: [...files, addedFileDiff('.env', 'TOKEN=1\n')] };
  const priced: ModelInfo = {
    ...MODEL,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    promptCaching: { minTokens: 512 },
  };
  const workspace = {
    readFile: () => Promise.resolve(''),
    grep: () => Promise.resolve([]),
    findReferences: () => Promise.resolve([]),
    getSymbolAt: () => Promise.resolve(null),
  };

  it('single-pass with caching, summary and verify', () => {
    expect(
      estimateReview(diff, {
        model: priced,
        config: DEFAULT_CONFIG,
        maxChunkTokens: 4_000,
        summary: true,
        verify: true,
        rules: { sources: [{ path: 'AGENTS.md', text: 'Never use `any`.' }] },
      }),
    ).toMatchInlineSnapshot(`
      {
        "costUsd": {
          "high": 0.6540927,
          "low": 0.16141470000000002,
        },
        "files": 6,
        "inputTokens": 60924,
        "mode": "single-pass",
        "outputTokens": {
          "high": 24800,
          "low": 2000,
        },
        "requests": 13,
        "skipped": 1,
        "verify": {
          "maxInputTokens": 32226,
          "maxRequests": 6,
        },
      }
    `);
  });

  it('agentic', () => {
    expect(
      estimateReview(diff, {
        model: priced,
        config: { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, mode: 'agentic' } },
        maxChunkTokens: 4_000,
        summary: true,
        workspace,
        agentLimits: { maxTurns: 4 },
      }),
    ).toMatchInlineSnapshot(`
      {
        "costUsd": {
          "high": 7.903465349999999,
          "low": 0.16503135,
        },
        "files": 6,
        "inputTokens": 67080,
        "inputTokensHigh": 2412558,
        "mode": "agentic",
        "outputTokens": {
          "high": 48800,
          "low": 2000,
        },
        "requests": 13,
        "skipped": 1,
      }
    `);
  });

  it('without pricing or context', () => {
    expect(estimateReview(diff, { model: MODEL, config: DEFAULT_CONFIG, context: false }))
      .toMatchInlineSnapshot(`
      {
        "files": 6,
        "inputTokens": 28617,
        "mode": "single-pass",
        "outputTokens": {
          "high": 4000,
          "low": 300,
        },
        "requests": 2,
        "skipped": 1,
      }
    `);
  });
});
