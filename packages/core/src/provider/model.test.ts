import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../agent/loop';
import { DEFAULT_CONFIG } from '../config/schema';
import { addedFileDiff } from '../diff/parse';
import { runReview } from '../review/orchestrator';
import { REPORT_TOOL_NAME } from '../review/output';
import { VERIFY_TOOL_NAME } from '../review/verify';
import { MOCK_MODEL, MockProvider, mockText, mockToolCall } from './mock';
import { parseModelInfo, withModelValidation } from './model';
import { withSecretRedaction } from './redaction';
import type { ChatRequest, ModelInfo } from './types';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Model',
  vendor: 'test',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
  pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  promptCaching: { minTokens: 512 },
};

const parse = (raw: unknown) => {
  const warnings: string[] = [];
  return { model: parseModelInfo(raw, { warn: (w) => warnings.push(w) }), warnings };
};

describe('parseModelInfo (A6)', () => {
  it('keeps a valid model as it is, without warnings', () => {
    expect(parse(MODEL)).toEqual({ model: MODEL, warnings: [] });
    expect(parse(MOCK_MODEL)).toEqual({ model: MOCK_MODEL, warnings: [] });
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['zero', 0],
    ['fractional', 4_096.5],
    ['infinite', Number.POSITIVE_INFINITY],
    ['absurd', 1e300],
    ['string', '200k'],
    ['missing', undefined],
  ])('rejects a model with a %s token limit: a review could not be sized for it', (_l, value) => {
    for (const field of ['maxInputTokens', 'maxOutputTokens']) {
      const { model, warnings } = parse({ ...MODEL, [field]: value });
      expect(model).toBeUndefined();
      expect(warnings).toEqual([expect.stringMatching(new RegExp(`"m".*${field}`))]);
    }
  });

  it.each([
    ['not an object', 'claude'],
    ['null', null],
    ['without an id', { ...MODEL, id: undefined }],
    ['with an empty id', { ...MODEL, id: ' ' }],
    ['with a numeric id', { ...MODEL, id: 7 }],
  ])('rejects a model %s', (_l, raw) => {
    const { model, warnings } = parse(raw);
    expect(model).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('repairs the name, vendor and tool support, with a warning each', () => {
    const { model, warnings } = parse({
      ...MODEL,
      name: '',
      vendor: undefined,
      supportsTools: 'yes',
    });
    // JSON-only reviews work with every model; tool calls don't.
    expect(model).toEqual({ ...MODEL, name: 'm', vendor: '', supportsTools: false });
    expect(warnings).toEqual([
      expect.stringMatching(/name/),
      expect.stringMatching(/vendor/),
      expect.stringMatching(/supportsTools/),
    ]);
    expect(parseModelInfo({ ...MODEL, vendor: 3 }, { vendor: 'copilot' })?.vendor).toBe('copilot');
  });

  it('drops pricing without both valid base prices: no cost estimate rather than NaN', () => {
    for (const pricing of [
      { inputPerMTok: 1 },
      { inputPerMTok: -1, outputPerMTok: 5 },
      { inputPerMTok: 1, outputPerMTok: Number.NaN },
      { inputPerMTok: '1', outputPerMTok: 5 },
      'cheap',
    ]) {
      const { model, warnings } = parse({ ...MODEL, pricing });
      expect(model).toBeDefined();
      expect(model).not.toHaveProperty('pricing');
      expect(warnings).toEqual([expect.stringMatching(/pricing/)]);
    }
  });

  it('drops an invalid cache price only (the cost falls back to the input price)', () => {
    const { model, warnings } = parse({
      ...MODEL,
      pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: -0.1, cacheWritePerMTok: 2 },
    });
    expect(model!.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 2 });
    expect(warnings).toEqual([expect.stringMatching(/cacheReadPerMTok/)]);
  });

  it('drops invalid prompt caching, and ignores unknown fields', () => {
    for (const promptCaching of [{ minTokens: -1 }, { minTokens: '512' }, true]) {
      const { model, warnings } = parse({ ...MODEL, promptCaching, extra: 1 });
      expect(model).toEqual({ ...MODEL, promptCaching: undefined });
      expect(model).not.toHaveProperty('promptCaching');
      expect(model).not.toHaveProperty('extra');
      expect(warnings).toEqual([expect.stringMatching(/promptCaching/)]);
    }
  });

  it('does not change the model it is given', () => {
    const raw = Object.freeze({ ...MODEL, name: '', pricing: Object.freeze({ inputPerMTok: 1 }) });
    expect(() => parseModelInfo(raw)).not.toThrow();
    expect(raw.name).toBe('');
  });
});

describe('withModelValidation (A6)', () => {
  const bad = { ...MODEL, id: 'bad', maxInputTokens: Number.NaN };
  const nameless = { ...MODEL, id: 'nameless', name: undefined } as unknown as ModelInfo;

  it('lists only usable models, repaired, and reports each problem once', async () => {
    const warnings: string[] = [];
    const provider = withModelValidation(
      new MockProvider({ id: 'copilot', models: [MODEL, bad, nameless] }),
      (w) => warnings.push(w),
    );
    const listed = await provider.listModels();
    expect(listed.map((m) => [m.id, m.name])).toEqual([
      ['m', 'Model'],
      ['nameless', 'nameless'],
    ]);
    await provider.listModels();
    expect(warnings).toEqual([
      expect.stringMatching(/^copilot: .*"bad".*maxInputTokens/),
      expect.stringMatching(/^copilot: .*"nameless".*name/),
    ]);
  });

  it('a provider that lists something else than models offers none', async () => {
    const warnings: string[] = [];
    const broken = new MockProvider();
    broken.listModels = async () => 'gpt' as unknown as ModelInfo[];
    expect(await withModelValidation(broken, (w) => warnings.push(w)).listModels()).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/^mock: /)]);
  });

  it('keeps the id, token counts and chat of the provider, behind the secret gate too', async () => {
    const mock = new MockProvider({ id: 'copilot', fallback: mockText('ok') });
    const wrapped = withSecretRedaction(withModelValidation(mock));
    expect(wrapped.id).toBe('copilot');
    expect(await wrapped.listModels()).toEqual(await mock.listModels());
    expect(await wrapped.countTokens('m', 'abcd')).toBe(await mock.countTokens('m', 'abcd'));
    for await (const _ of wrapped.chat({
      model: 'mock-model',
      system: [],
      messages: [],
      signal: new AbortController().signal,
    })) {
      // drain
    }
    expect(mock.requests).toHaveLength(1);
  });
});

describe('ChatRequest has no temperature (A6)', () => {
  it('is not a field: no provider honours it', () => {
    const req: ChatRequest = {
      model: 'm',
      system: [],
      messages: [],
      signal: new AbortController().signal,
      // @ts-expect-error -- Anthropic rejects sampling parameters; vscode.lm has no portable one.
      temperature: 0,
    };
    expect(req.model).toBe('m');
  });

  it('is not sent by the reviewer, verify pass, summary or agent loop', async () => {
    const provider = new MockProvider({
      script: [
        mockToolCall(REPORT_TOOL_NAME, {
          findings: [
            {
              file: 'src/a.ts',
              startLine: 2,
              endLine: 2,
              severity: 'major',
              category: 'bug',
              title: 'Wrong operator',
              body: 'Should be `-`.',
              quote: 'return a + b;',
              confidence: 0.9,
            },
          ],
        }),
        mockToolCall(VERIFY_TOOL_NAME, { verdicts: [{ id: 'F1', real: true, reason: 'r' }] }),
        mockText('walkthrough'),
        mockToolCall('done', {}),
      ],
    });
    await runReview(
      { files: [addedFileDiff('src/a.ts', 'export function sub(a, b) {\n  return a + b;\n}\n')] },
      { provider, model: MOCK_MODEL, config: DEFAULT_CONFIG, verify: true, summary: true },
    );
    await runAgentLoop({
      provider,
      model: MOCK_MODEL,
      system: [{ text: 'sys' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [],
      finalTool: { name: 'done', description: 'finish', inputSchema: { type: 'object' } },
      checkFinal: () => ({ ok: true }),
      maxOutputTokens: 1000,
      signal: new AbortController().signal,
    });
    expect(provider.requests).toHaveLength(4);
    for (const req of provider.requests) expect(req).not.toHaveProperty('temperature');
  });
});
