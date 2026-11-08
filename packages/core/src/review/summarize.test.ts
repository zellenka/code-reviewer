import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { addedFileDiff } from '../diff/parse';
import type { UnifiedDiff } from '../diff/types';
import { MockProvider, mockError, mockText, mockToolCall } from '../provider/mock';
import type { ModelInfo } from '../provider/types';
import { estimateTokens } from '../provider/usage';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, runReview } from './orchestrator';
import { diffStats } from './summarize';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
  pricing: { inputPerMTok: 2, outputPerMTok: 10 },
};

const DIFF: UnifiedDiff = {
  files: [
    addedFileDiff('src/a.ts', 'export function sub(a, b) {\n  return a + b;\n}\n'),
    addedFileDiff('.env', 'TOKEN=secret\n'),
  ],
};

const finding = {
  file: 'src/a.ts',
  startLine: 2,
  endLine: 2,
  severity: 'major',
  category: 'bug',
  title: 'Wrong operator',
  body: 'Should be `-`.',
  quote: 'return a + b;',
  confidence: 0.9,
};

describe('summary', () => {
  it('adds one request after the review with stats and findings', async () => {
    const provider = new MockProvider({
      script: [
        mockToolCall(REPORT_TOOL_NAME, { findings: [finding] }),
        mockText('## Walkthrough\n- a.ts adds sub()\n\n## Top risks\n- wrong operator'),
      ],
    });
    const result = await runReview(DIFF, {
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
    });
    expect(result.summary).toMatch(/## Walkthrough/);
    expect(provider.requests).toHaveLength(2);
    const summaryRequest = provider.requests[1]!;
    expect(summaryRequest.tools).toBeUndefined();
    const sent = JSON.stringify(summaryRequest.messages);
    expect(sent).toContain('src/a.ts (added, +3');
    expect(sent).toContain('Wrong operator');
    expect(sent).not.toContain('TOKEN=secret');
    expect(result.usage.requests).toBe(2);
  });

  it('is skipped by default', async () => {
    const provider = new MockProvider({
      script: [mockToolCall(REPORT_TOOL_NAME, { findings: [] })],
    });
    const result = await runReview(DIFF, { provider, model: MODEL, config: DEFAULT_CONFIG });
    expect(result.summary).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  });

  it('cancelling during the summary keeps the review complete', async () => {
    const controller = new AbortController();
    const provider = new MockProvider({
      script: [
        mockToolCall(REPORT_TOOL_NAME, { findings: [finding] }),
        () => {
          controller.abort();
          return { events: [], delayMs: 50 };
        },
      ],
    });
    const result = await runReview(DIFF, {
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
      signal: controller.signal,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBeUndefined();
    expect(result.cancelled).toBe(false);
  });

  it('a failing summary keeps the findings', async () => {
    const provider = new MockProvider({
      script: [mockToolCall(REPORT_TOOL_NAME, { findings: [finding] }), mockError('server')],
    });
    const result = await runReview(DIFF, {
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBeUndefined();
    expect(result.errors.some((e) => e.startsWith('Summary:'))).toBe(true);
  });

  it('diffStats counts added and removed lines', () => {
    expect(diffStats(DIFF.files)[0]).toMatchObject({ path: 'src/a.ts', added: 3, removed: 0 });
  });
});

describe('estimateReview', () => {
  it('counts requests exactly and input tokens close to what is sent', async () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      addedFileDiff(
        `src/f${i}.ts`,
        Array.from(
          { length: 300 },
          (_, n) => `export const v${i}_${n} = compute(${n}, 'x');\n`,
        ).join(''),
      ),
    );
    const diff: UnifiedDiff = { files };
    expect(
      estimateReview(diff, { model: MODEL, config: DEFAULT_CONFIG, maxChunkTokens: 4_000 })
        .requests,
    ).toBeGreaterThan(1);
    const options = { model: MODEL, config: DEFAULT_CONFIG, maxChunkTokens: 4_000 };
    const estimate = estimateReview(diff, options);

    const provider = new MockProvider({
      fallback: mockToolCall(REPORT_TOOL_NAME, { findings: [] }),
    });
    await runReview(diff, { ...options, provider });
    expect(estimate.requests).toBe(provider.requests.length);
    const actual = provider.requests.reduce(
      (sum, r) =>
        sum +
        estimateTokens(r.system.map((s) => s.text).join('')) +
        estimateTokens(JSON.stringify(r.tools ?? [])) +
        estimateTokens(
          r.messages
            .flatMap((m) => m.content)
            .map((p) => (p.type === 'text' ? p.text : ''))
            .join(''),
        ),
      0,
    );
    expect(Math.abs(estimate.inputTokens - actual) / actual).toBeLessThan(0.05);
    expect(estimate.costUsd!.low).toBeLessThan(estimate.costUsd!.high);
  });

  it('adds the summary request and skips filtered files', () => {
    const plain = estimateReview(DIFF, { model: MODEL, config: DEFAULT_CONFIG });
    const withSummary = estimateReview(DIFF, {
      model: MODEL,
      config: DEFAULT_CONFIG,
      summary: true,
    });
    expect(plain).toMatchObject({ files: 1, skipped: 1, requests: 1 });
    expect(withSummary.requests).toBe(2);
    expect(withSummary.inputTokens).toBeGreaterThan(plain.inputTokens);
  });

  it('has no cost without pricing', () => {
    const { pricing: _pricing, ...noPrice } = MODEL;
    expect(
      estimateReview(DIFF, { model: noPrice, config: DEFAULT_CONFIG }).costUsd,
    ).toBeUndefined();
  });
});
