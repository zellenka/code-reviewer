import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { addedFileDiff, parseUnifiedDiff } from '../diff/parse';
import type { UnifiedDiff } from '../diff/types';
import { MockProvider, mockError, mockText, mockToolCall, type MockStep } from '../provider/mock';
import type { ChatRequest, ModelInfo } from '../provider/types';
import { estimateTokens } from '../provider/usage';
import { ReviewTooLargeError, chunkFiles, renderChunk } from './chunker';
import { REPORT_TOOL_NAME } from './output';
import { runReview } from './orchestrator';
import { reviewChunk } from './reviewer';

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
