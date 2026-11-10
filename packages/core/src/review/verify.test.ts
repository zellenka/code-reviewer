import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { addedFileDiff } from '../diff/parse';
import type { UnifiedDiff } from '../diff/types';
import { MockProvider, mockError, mockToolCall } from '../provider/mock';
import type { ModelInfo } from '../provider/types';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, runReview } from './orchestrator';
import type { Finding } from './types';
import { VERIFY_TOOL_NAME, buildVerifyUserPrompt, parseVerdicts, verifyFindings } from './verify';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
  pricing: { inputPerMTok: 3, outputPerMTok: 15 },
};

const CODE = 'export function sub(a, b) {\n  return a + b;\n}\n\nexport const KEY = 1;\n';
const FILE = addedFileDiff('src/a.ts', CODE);
const DIFF: UnifiedDiff = { files: [FILE] };

const raw = (over: Record<string, unknown> = {}) => ({
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

const finding = (line: number, title: string): Finding => ({
  id: title,
  file: 'src/a.ts',
  startLine: line,
  endLine: line,
  anchor: 'line',
  severity: 'major',
  category: 'bug',
  title,
  body: 'body',
  quote: 'x',
  confidence: 0.9,
});

const verdicts = (list: { id: string; real: boolean; reason?: string }[]) =>
  mockToolCall(VERIFY_TOOL_NAME, { verdicts: list.map((v) => ({ reason: 'r', ...v })) });

const signal = new AbortController().signal;

describe('verifyFindings', () => {
  it('drops rejected findings and keeps the rest in order', async () => {
    const provider = new MockProvider({
      script: [
        verdicts([
          { id: 'F1', real: true },
          { id: 'F2', real: false, reason: 'no' },
        ]),
      ],
    });
    const result = await verifyFindings({
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      files: [FILE],
      findings: [finding(2, 'a'), finding(5, 'b')],
      signal,
    });
    expect(result.findings.map((f) => f.title)).toEqual(['a']);
    expect(result.rejected).toEqual([{ finding: finding(5, 'b'), reason: 'no' }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.toolChoice).toEqual({ name: VERIFY_TOOL_NAME });
    expect(provider.requests[0]!.system[0]!.text).toMatch(/untrusted data/);
  });

  it('keeps findings when the request fails or the answer is unusable', async () => {
    for (const step of [mockError('server'), mockToolCall(VERIFY_TOOL_NAME, { nope: 1 })]) {
      const provider = new MockProvider({ script: [step] });
      const result = await verifyFindings({
        provider,
        model: MODEL,
        config: DEFAULT_CONFIG,
        files: [FILE],
        findings: [finding(2, 'a')],
        signal,
      });
      expect(result.findings).toHaveLength(1);
      expect(result.failed).toBe(1);
    }
  });

  it('keeps findings without a verdict', async () => {
    const provider = new MockProvider({ script: [verdicts([{ id: 'F2', real: false }])] });
    const result = await verifyFindings({
      provider,
      model: MODEL,
      config: DEFAULT_CONFIG,
      files: [FILE],
      findings: [finding(2, 'a')],
      signal,
    });
    expect(result.findings).toHaveLength(1);
  });

  it('sends code from the redacted files only, never the finding quote', () => {
    const secret = { ...finding(2, 'leak'), quote: 'AKIAREALSECRETVALUE1' };
    const prompt = buildVerifyUserPrompt(FILE, [secret]);
    expect(prompt).not.toContain('AKIAREALSECRETVALUE1');
    expect(prompt).toContain('return a + b;');
    expect(prompt).toContain('<finding id="F1" lines="2-2"');
  });

  it('parses lenient verdict shapes', () => {
    expect(parseVerdicts([{ id: 1, real: 'no' }])?.get('F1')?.real).toBe(false);
    expect(parseVerdicts('{"verdicts":[{"id":"f2","real":true}]}')?.get('F2')?.real).toBe(true);
    expect(parseVerdicts({ other: [] })).toBeUndefined();
  });
});

describe('runReview with verify', () => {
  it('drops rejected findings, counts them and adds the usage', async () => {
    const provider = new MockProvider({
      script: [
        mockToolCall(REPORT_TOOL_NAME, {
          findings: [
            raw(),
            raw({ startLine: 5, endLine: 5, quote: 'export const KEY = 1;', title: 'Meh' }),
          ],
        }),
        verdicts([
          { id: 'F1', real: true },
          { id: 'F2', real: false },
        ]),
      ],
    });
    const result = await runReview(DIFF, {
      provider,
      model: MODEL,
      config: { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, verify: true } },
    });
    expect(result.findings.map((f) => f.title)).toEqual(['Wrong operator']);
    expect(result.verify).toEqual({ checked: 2, rejected: 1, failed: 0 });
    expect(result.dropped).toContainEqual({ reason: 'rejectedByVerify', count: 1 });
    expect(result.usage.requests).toBe(2);
  });

  it('is off by default and skipped when there are no findings', async () => {
    const off = new MockProvider({
      script: [mockToolCall(REPORT_TOOL_NAME, { findings: [raw()] })],
    });
    const r1 = await runReview(DIFF, { provider: off, model: MODEL, config: DEFAULT_CONFIG });
    expect(r1.verify).toBeUndefined();
    expect(off.requests).toHaveLength(1);

    const none = new MockProvider({ script: [mockToolCall(REPORT_TOOL_NAME, { findings: [] })] });
    const r2 = await runReview(DIFF, {
      provider: none,
      model: MODEL,
      config: DEFAULT_CONFIG,
      verify: true,
    });
    expect(r2.verify).toBeUndefined();
    expect(none.requests).toHaveLength(1);
  });

  it('adds the verify pass to the high cost estimate only', () => {
    const plain = estimateReview(DIFF, { model: MODEL, config: DEFAULT_CONFIG });
    const verified = estimateReview(DIFF, { model: MODEL, config: DEFAULT_CONFIG, verify: true });
    expect(verified.verify).toEqual({ maxRequests: 1, maxInputTokens: expect.any(Number) });
    expect(verified.costUsd!.low).toBe(plain.costUsd!.low);
    expect(verified.costUsd!.high).toBeGreaterThan(plain.costUsd!.high);
    expect(verified.requests).toBe(plain.requests);
  });
});
