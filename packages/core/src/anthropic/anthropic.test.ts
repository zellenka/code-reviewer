import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { addedFileDiff } from '../diff/parse';
import { noopLogger } from '../logger';
import { collectChat } from '../provider/collect';
import {
  PROVIDER_CONFORMANCE,
  type ConformanceHarness,
  type ConformanceStep,
} from '../provider/conformance';
import type { ChatRequest } from '../provider/types';
import { runReview } from '../review/orchestrator';
import { mapAnthropicError, parseRetryAfter } from './errors';
import { mergeModels, ANTHROPIC_MODELS } from './models';
import { AnthropicProvider, buildParams, type AnthropicClientLike } from './provider';

function apiError(status: number, type: string, headers: Record<string, string> = {}) {
  return APIError.generate(
    status,
    { type: 'error', error: { type, message: `${type} happened` } },
    undefined,
    new Headers(headers),
  );
}

describe('mapAnthropicError', () => {
  it.each([
    [401, 'authentication_error', 'auth', false],
    [403, 'permission_error', 'auth', false],
    [402, 'billing_error', 'quota', false],
    [404, 'not_found_error', 'notFound', false],
    [413, 'request_too_large', 'contextTooLong', false],
    [429, 'rate_limit_error', 'rateLimit', true],
    [500, 'api_error', 'server', true],
    [529, 'overloaded_error', 'server', true],
    [400, 'invalid_request_error', 'unknown', false],
  ] as const)('%i %s → %s', (status, type, kind, retryable) => {
    const err = mapAnthropicError(apiError(status, type));
    expect(err).toMatchObject({ kind, retryable, provider: 'anthropic' });
    expect(err.message).toContain(`${type} happened`);
  });

  it('detects prompt-too-long 400s', () => {
    const err = APIError.generate(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 1200000 tokens > 1000000 maximum',
        },
      },
      undefined,
      new Headers(),
    );
    expect(mapAnthropicError(err).kind).toBe('contextTooLong');
  });

  it.each([
    [
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      'quota',
    ],
    [
      'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
      'quota',
    ],
    [
      'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
      'quota',
    ],
    ['This organization has been disabled.', 'auth'],
    ['messages: text content blocks must be non-empty', 'unknown'],
  ] as const)('maps the account-level 400 "%s" → %s', (message, kind) => {
    const err = mapAnthropicError(
      APIError.generate(
        400,
        { type: 'error', error: { type: 'invalid_request_error', message } },
        undefined,
        new Headers(),
      ),
    );
    expect(err).toMatchObject({ kind, retryable: false });
    expect(err.message).toContain(message);
  });

  it('stops a multi-part review at the first credit-balance error', async () => {
    const credit = () =>
      APIError.generate(
        400,
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Your credit balance is too low to access the Anthropic API.',
          },
        },
        undefined,
        new Headers(),
      );
    const { p, calls } = provider(Array.from({ length: 10 }, () => ({ error: credit() })));
    const files = Array.from({ length: 4 }, (_, i) =>
      addedFileDiff(`f${i}.ts`, 'z\n'.repeat(3000)),
    );
    await expect(
      runReview(
        { files },
        {
          provider: p,
          model: { ...ANTHROPIC_MODELS[0]!, maxInputTokens: 12_000, maxOutputTokens: 4_000 },
          config: DEFAULT_CONFIG,
          concurrency: 1,
        },
      ),
    ).rejects.toMatchObject({ kind: 'quota' });
    expect(calls).toHaveLength(1);
  });

  it('reads retry-after', () => {
    expect(
      mapAnthropicError(apiError(429, 'rate_limit_error', { 'retry-after': '7' })).retryAfterMs,
    ).toBe(7000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(
      parseRetryAfter(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000),
    ).toBe(6000);
  });

  it('keeps odd retry-after values sane', () => {
    const parse = (value: string) => parseRetryAfter(new Headers({ 'retry-after': value }), 4_000);
    expect(parse('-5')).toBe(0);
    expect(parse('0')).toBe(0);
    expect(parse(new Date(1_000).toUTCString())).toBe(0);
    expect(parse('soon')).toBeUndefined();
    expect(parse('NaN')).toBeUndefined();
    expect(parse('Infinity')).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '0', 'retry-after': '2' }))).toBe(2000);
  });

  it('maps mid-stream errors (no status) by type', () => {
    const err = new APIError(
      undefined,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      'Overloaded',
      undefined,
      'overloaded_error',
    );
    expect(mapAnthropicError(err)).toMatchObject({ kind: 'server', retryable: true });
  });

  it('maps connection errors to network', () => {
    expect(mapAnthropicError(new APIConnectionError({ message: 'ECONNRESET' }))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });
});

// ---------- fake SDK client ----------

function finalMessage(
  content: BetaMessage['content'],
  stop: BetaMessage['stop_reason'] = 'end_turn',
): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
  } as unknown as BetaMessage;
}

type Step = { deltas?: string[]; message?: BetaMessage; error?: unknown };

function fakeClient(steps: Step[]) {
  const calls: BetaMessageStreamParams[] = [];
  const client: AnthropicClientLike = {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const step = steps.shift() ?? { error: new Error('no more steps') };
          return {
            async *[Symbol.asyncIterator]() {
              if (step.error) throw step.error;
              for (const text of step.deltas ?? []) {
                yield {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text },
                } as BetaRawMessageStreamEvent;
              }
            },
            finalMessage: async () => step.message ?? finalMessage([]),
            abort() {},
          };
        },
      },
    },
  };
  return { client, calls };
}

const baseReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'claude-opus-5-5',
  system: [{ text: 'sys', cache: true }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  signal: new AbortController().signal,
  ...over,
});

function provider(steps: Step[], extra: ConstructorParameters<typeof AnthropicProvider>[0] = {}) {
  const fake = fakeClient(steps);
  const p = new AnthropicProvider({
    apiKey: 'sk-ant-test',
    createClient: () => fake.client,
    retry: { sleep: async () => {} },
    ...extra,
  });
  return { p, calls: fake.calls };
}

describe('AnthropicProvider', () => {
  it('streams text, tool calls, usage and keeps opaque blocks in order', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const { p } = provider([
      {
        deltas: ['Hel', 'lo'],
        message: finalMessage(
          [
            thinking,
            { type: 'text', text: 'Hello', citations: null },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'add',
              input: { a: 1 },
              caller: { type: 'direct' },
            },
          ] as unknown as BetaMessage['content'],
          'tool_use',
        ),
      },
    ]);
    const res = await collectChat(p.chat(baseReq()));
    expect(res.text).toBe('Hello');
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'add', input: { a: 1 } }]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.message.map((c) => c.type)).toEqual(['opaque', 'text', 'tool_call']);
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      requests: 1,
    });
  });

  it('echoes opaque blocks back and maps tool results', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const { p, calls } = provider([
      {
        message: finalMessage([
          { type: 'text', text: '3', citations: null },
        ] as unknown as BetaMessage['content']),
      },
    ]);
    await collectChat(
      p.chat(
        baseReq({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'add' }] },
            {
              role: 'assistant',
              content: [
                { type: 'opaque', provider: 'anthropic', data: thinking },
                { type: 'opaque', provider: 'copilot', data: 'dropped' },
                { type: 'tool_call', id: 'tu_1', name: 'add', input: { a: 1 } },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', callId: 'tu_1', content: 'boom', isError: true }],
            },
          ],
        }),
      ),
    );
    expect(calls[0]?.messages[1]?.content).toEqual([
      thinking,
      { type: 'tool_use', id: 'tu_1', name: 'add', input: { a: 1 } },
    ]);
    expect(calls[0]?.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'boom', is_error: true },
    ]);
  });

  it('retries 429 then succeeds', async () => {
    const { p, calls } = provider([
      { error: apiError(429, 'rate_limit_error', { 'retry-after': '1' }) },
      {
        message: finalMessage([
          { type: 'text', text: 'ok', citations: null },
        ] as unknown as BetaMessage['content']),
      },
    ]);
    const res = await collectChat(p.chat(baseReq()));
    expect(res.message).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toHaveLength(2);
  });

  it('throws auth without a key', async () => {
    const p = new AnthropicProvider({ apiKey: async () => undefined });
    await expect(collectChat(p.chat(baseReq()))).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a refusal to blocked', async () => {
    const msg = finalMessage([], 'refusal');
    (msg as unknown as { stop_details: unknown }).stop_details = {
      type: 'refusal',
      category: 'cyber',
      explanation: null,
    };
    const { p } = provider([{ message: msg }]);
    await expect(collectChat(p.chat(baseReq()))).rejects.toMatchObject({
      kind: 'blocked',
      retryable: false,
    });
  });

  it('turns an abort into stop: cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { p } = provider([{ error: new APIUserAbortError() }]);
    const res = await collectChat(p.chat(baseReq({ signal: controller.signal })));
    expect(res.stopReason).toBe('cancelled');
  });

  it('drops a tool call cut off by the output limit', async () => {
    const { p } = provider([
      {
        message: finalMessage(
          [
            { type: 'text', text: 'Let me add', citations: null },
            { type: 'tool_use', id: 'tu_1', name: 'add', input: { a: 1 } },
          ] as unknown as BetaMessage['content'],
          'max_tokens',
        ),
      },
    ]);
    const res = await collectChat(p.chat(baseReq()));
    expect(res.stopReason).toBe('max_tokens');
    expect(res.toolCalls).toEqual([]);
    expect(res.message).toEqual([{ type: 'text', text: 'Let me add' }]);
  });

  it('turns refusal fallback off when the account rejects the beta', async () => {
    const rejected = APIError.generate(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.',
        },
      },
      undefined,
      new Headers(),
    );
    const ok = {
      message: finalMessage([
        { type: 'text', text: 'ok', citations: null },
      ] as unknown as BetaMessage['content']),
    };
    const { p, calls } = provider([{ error: rejected }, ok, ok]);
    expect((await collectChat(p.chat(baseReq()))).text).toBe('');
    expect(calls.map((c) => c.fallbacks)).toEqual(['default', undefined]);
    await collectChat(p.chat(baseReq()));
    expect(calls[2]?.fallbacks).toBeUndefined();
  });

  it('applies model overrides from settings', async () => {
    const p = new AnthropicProvider({
      modelOverrides: () => [
        { id: 'claude-opus-5-5', pricing: { inputPerMTok: 3 } },
        { id: 'claude-custom' },
        { bad: true },
      ],
    });
    const models = await p.listModels();
    expect(models.find((m) => m.id === 'claude-opus-5-5')?.pricing).toMatchObject({
      inputPerMTok: 3,
      outputPerMTok: 20,
    });
    expect(models.find((m) => m.id === 'claude-custom')).toMatchObject({
      name: 'claude-custom',
      vendor: 'anthropic',
    });
    expect(models).toHaveLength(ANTHROPIC_MODELS.length + 1);
    expect(mergeModels(ANTHROPIC_MODELS)).toEqual(ANTHROPIC_MODELS);
  });

  it('logs each invalid model override once', async () => {
    const warnings: string[] = [];
    const p = new AnthropicProvider({
      modelOverrides: () => [{ id: 'claude-opus-5-5', maxInputTokens: '200k' }],
      logger: { ...noopLogger, warn: (message) => warnings.push(message) },
    });
    const opus = ANTHROPIC_MODELS.find((m) => m.id === 'claude-opus-5-5')!;
    expect((await p.listModels()).find((m) => m.id === opus.id)).toEqual(opus);
    await p.listModels();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/claude-opus-5-5.*maxInputTokens/);
  });
});

describe('mergeModels', () => {
  const opus = ANTHROPIC_MODELS.find((m) => m.id === 'claude-opus-5-5')!;
  const merge = (overrides: unknown[]) => {
    const warnings: string[] = [];
    const models = mergeModels(ANTHROPIC_MODELS, overrides, (w) => warnings.push(w));
    return { models, warnings, find: (id: string) => models.find((m) => m.id === id) };
  };

  it('drops invalid fields and keeps the valid ones of the same entry', () => {
    const { find, warnings } = merge([
      {
        id: 'claude-opus-5-5',
        name: 'Opus (team)',
        maxInputTokens: '200k',
        maxOutputTokens: Number.NaN,
        supportsTools: 'yes',
        pricing: { inputPerMTok: 3, outputPerMTok: -1 },
      },
    ]);
    expect(find('claude-opus-5-5')).toEqual({
      ...opus,
      name: 'Opus (team)',
      pricing: { ...opus.pricing, inputPerMTok: 3 },
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toMatch(/maxInputTokens/);
    expect(warnings.join('\n')).toMatch(/maxOutputTokens/);
    expect(warnings.join('\n')).toMatch(/supportsTools/);
    expect(warnings.join('\n')).toMatch(/pricing\.outputPerMTok/);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1000],
    ['fractional', 1000.5],
    ['string', '200000'],
  ])('rejects a %s token limit', (_label, value) => {
    const { find, warnings } = merge([
      { id: 'claude-opus-5-5', maxInputTokens: value },
      { id: 'claude-new', maxInputTokens: value, maxOutputTokens: value },
    ]);
    expect(find('claude-opus-5-5')!.maxInputTokens).toBe(opus.maxInputTokens);
    expect(find('claude-new')).toMatchObject({ maxInputTokens: 200_000, maxOutputTokens: 32_000 });
    expect(warnings).toHaveLength(3);
  });

  it('ignores unknown keys and entries without an id, with a warning', () => {
    const { models, find, warnings } = merge([
      { bad: true },
      { id: '' },
      'claude-opus-5-5',
      { id: 'claude-opus-5-5', maxInputToken: 1000 },
    ]);
    expect(models).toHaveLength(ANTHROPIC_MODELS.length);
    expect(find('claude-opus-5-5')).toEqual(opus);
    expect(warnings).toHaveLength(4);
    expect(warnings[3]).toMatch(/maxInputToken/);
  });

  it('drops a nested object whose required field is invalid, keeping the rest', () => {
    const { find, warnings } = merge([
      { id: 'claude-opus-5-5', name: 'Mine', promptCaching: { minTokens: 'x' } },
      { id: 'new-m', maxInputTokens: 100_000, promptCaching: { minTokens: -1 } },
    ]);
    expect(find('claude-opus-5-5')).toEqual({ ...opus, name: 'Mine' });
    expect(find('new-m')).toMatchObject({ maxInputTokens: 100_000 });
    expect(find('new-m')?.promptCaching).toBeUndefined();
    expect(warnings).toEqual([
      expect.stringMatching(/claude-opus-5-5.*promptCaching\.minTokens/),
      expect.stringMatching(/new-m.*promptCaching\.minTokens/),
    ]);
  });

  it('drops incomplete pricing on a new model', () => {
    const { find, warnings } = merge([
      { id: 'claude-a', pricing: { inputPerMTok: 1 } },
      { id: 'claude-b', pricing: { inputPerMTok: 1, outputPerMTok: 5 } },
    ]);
    expect(find('claude-a')?.pricing).toBeUndefined();
    expect(find('claude-b')?.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(warnings).toEqual([expect.stringMatching(/claude-a.*outputPerMTok/)]);
  });

  it('accepts a fully valid override without warnings', () => {
    const { find, warnings } = merge([
      {
        id: 'claude-opus-5-5',
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        supportsTools: false,
        pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
        promptCaching: { minTokens: 1024 },
      },
    ]);
    expect(warnings).toEqual([]);
    expect(find('claude-opus-5-5')).toMatchObject({
      maxInputTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsTools: false,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      promptCaching: { minTokens: 1024 },
    });
  });

  it('does not modify the override objects', () => {
    const override = Object.freeze({
      id: 'claude-opus-5-5',
      maxInputTokens: 'x',
      pricing: Object.freeze({ inputPerMTok: -1 }),
    });
    merge([override]);
    expect(override).toEqual({
      id: 'claude-opus-5-5',
      maxInputTokens: 'x',
      pricing: { inputPerMTok: -1 },
    });
  });
});

describe('buildParams', () => {
  const tool = {
    name: 'report_findings',
    description: 'Report',
    inputSchema: { type: 'object', properties: {} },
  };

  it('turns a forced tool into auto + instruction + single call', () => {
    const params = buildParams(
      baseReq({ tools: [tool], toolChoice: { name: 'report_findings' } }),
      undefined,
      true,
    );
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params.system).toHaveLength(2);
    expect(JSON.stringify(params.system)).toContain('`report_findings`');
  });

  it('rejects a forced tool that is not in tools', () => {
    expect(() =>
      buildParams(baseReq({ tools: [tool], toolChoice: { name: 'nope' } }), undefined, true),
    ).toThrow(/not in tools/);
  });

  it('maps cache hints to at most 4 breakpoints', () => {
    const params = buildParams(
      baseReq({
        system: [1, 2, 3].map((n) => ({ text: `s${n}`, cache: true })),
        messages: [
          {
            role: 'user',
            content: [1, 2, 3].map((n) => ({ type: 'text' as const, text: `m${n}`, cache: true })),
          },
        ],
      }),
      undefined,
      false,
    );
    const marked = JSON.stringify(params).match(/cache_control/g) ?? [];
    expect(marked).toHaveLength(4);
  });

  it('puts a cache breakpoint on a tool result (agent loop turns)', () => {
    const params = buildParams(
      baseReq({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'x', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', callId: 't1', content: 'ok', cache: true }],
          },
        ],
      }),
      undefined,
      false,
    );
    expect(params.messages[2]!.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'ok',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('never sends temperature; enables refusal fallback only for supported models', () => {
    const p1 = buildParams(baseReq(), undefined, true);
    expect(p1).not.toHaveProperty('temperature');
    expect(p1.fallbacks).toBe('default');
    expect(p1.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(buildParams(baseReq({ model: 'claude-haiku-5-5' }), undefined, true)).not.toHaveProperty(
      'fallbacks',
    );
    expect(buildParams(baseReq(), undefined, false)).not.toHaveProperty('fallbacks');
  });

  it('caps max_tokens by default and respects maxOutputTokens', () => {
    expect(buildParams(baseReq(), ANTHROPIC_MODELS[0], false).max_tokens).toBe(32_000);
    expect(
      buildParams(baseReq({ maxOutputTokens: 500 }), ANTHROPIC_MODELS[0], false).max_tokens,
    ).toBe(500);
  });
});

describe('AnthropicProvider conformance', () => {
  const text = (value: string) =>
    [{ type: 'text', text: value, citations: null }] as unknown as BetaMessage['content'];
  const errors = {
    rateLimit: () => apiError(429, 'rate_limit_error'),
    quota: () => apiError(402, 'billing_error'),
    auth: () => apiError(401, 'authentication_error'),
  };

  /** Plays conformance steps as SDK streams. */
  function stepClient(steps: ConformanceStep[]) {
    let requests = 0;
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          stream(_params, options) {
            requests++;
            const step = steps.shift() ?? { kind: 'fail', error: 'quota' };
            const signal = options?.signal;
            const delta = (value: string) =>
              ({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: value },
              }) as BetaRawMessageStreamEvent;
            return {
              async *[Symbol.asyncIterator]() {
                if (step.kind === 'fail') {
                  if (step.error === 'blocked') return;
                  throw errors[step.error]();
                }
                yield delta(step.text);
                if (step.kind === 'failAfter') throw errors.rateLimit();
                if (step.kind === 'stall') {
                  if (!signal?.aborted) {
                    await new Promise((resolve) =>
                      signal?.addEventListener('abort', resolve, { once: true }),
                    );
                  }
                  throw new APIUserAbortError();
                }
              },
              finalMessage: async () =>
                step.kind === 'fail'
                  ? finalMessage([], 'refusal')
                  : finalMessage(
                      text(step.text),
                      step.kind === 'truncated' ? 'max_tokens' : 'end_turn',
                    ),
              abort() {},
            };
          },
        },
      },
    };
    return { client, requests: () => requests };
  }

  const harness: ConformanceHarness = {
    model: 'claude-opus-5-5',
    reportsTruncation: true,
    create(steps) {
      const fake = stepClient([...steps]);
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test',
        createClient: () => fake.client,
        retry: { sleep: async () => {} },
      });
      return { provider, requests: fake.requests };
    },
  };

  for (const c of PROVIDER_CONFORMANCE) it(c.name, () => c.run(harness));
});
