import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { collectChat } from '../provider/collect';
import type { ChatRequest } from '../provider/types';
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

  it('reads retry-after', () => {
    expect(
      mapAnthropicError(apiError(429, 'rate_limit_error', { 'retry-after': '7' })).retryAfterMs,
    ).toBe(7000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(
      parseRetryAfter(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000),
    ).toBe(6000);
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

  it('never sends temperature; enables refusal fallback only for supported models', () => {
    const p1 = buildParams(baseReq({ temperature: 0 }), undefined, true);
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
