import { describe, expect, it } from 'vitest';
import { collectChat } from './collect';
import { PROVIDER_ERROR_KINDS, ProviderError, isProviderError } from './errors';
import { MockProvider, mockError, mockText, mockToolCall } from './mock';
import type { ChatEvent, ChatRequest } from './types';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'mock-model',
    system: [{ text: 'You are a reviewer.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function events(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('MockProvider', () => {
  it('replays text in chunks and ends with message, usage, stop', async () => {
    const provider = new MockProvider({ script: [mockText('hello world', 5)] });
    const out = await events(provider.chat(request()));
    expect(out.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(
      ['hello', ' worl', 'd'],
    );
    expect(out.slice(-3).map((e) => e.type)).toEqual(['message', 'usage', 'stop']);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('replays a tool-call round trip and records requests', async () => {
    const provider = new MockProvider({
      script: [
        mockToolCall('add', { a: 2, b: 3 }, { id: 'c1', text: 'Let me add.' }),
        mockText('5'),
      ],
    });
    const first = await collectChat(
      provider.chat(request({ tools: [{ name: 'add', description: '', inputSchema: {} }] })),
    );
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: 'c1', name: 'add', input: { a: 2, b: 3 } }]);
    expect(first.message).toEqual([
      { type: 'text', text: 'Let me add.' },
      { type: 'tool_call', id: 'c1', name: 'add', input: { a: 2, b: 3 } },
    ]);

    const second = await collectChat(
      provider.chat(
        request({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'add 2 and 3' }] },
            { role: 'assistant', content: first.message },
            { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: '5' }] },
          ],
        }),
      ),
    );
    expect(second.text).toBe('5');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages[2]?.content[0]).toMatchObject({
      type: 'tool_result',
      callId: 'c1',
    });
    expect(provider.remaining).toBe(0);
  });

  it.each(PROVIDER_ERROR_KINDS)('throws a ProviderError of kind %s', async (kind) => {
    const provider = new MockProvider({ script: [mockError(kind)] });
    const err = await events(provider.chat(request())).catch((e: unknown) => e);
    expect(isProviderError(err)).toBe(true);
    expect((err as ProviderError).kind).toBe(kind);
  });

  it('can fail mid-stream after some events', async () => {
    const provider = new MockProvider({
      script: [
        {
          events: [{ type: 'text', delta: 'partial' }],
          error: new ProviderError('network', 'reset'),
        },
      ],
    });
    const seen: string[] = [];
    await expect(collectChat(provider.chat(request()), (d) => seen.push(d))).rejects.toMatchObject({
      kind: 'network',
    });
    expect(seen).toEqual(['partial']);
  });

  it('computes steps from the request', async () => {
    const provider = new MockProvider({ fallback: (req) => mockText(`model=${req.model}`) });
    const res = await collectChat(provider.chat(request({ model: 'm2' })));
    expect(res.text).toBe('model=m2');
  });

  it('stops with "cancelled" when the signal is aborted', async () => {
    const controller = new AbortController();
    const provider = new MockProvider({
      script: [
        {
          events: [
            { type: 'text', delta: 'a' },
            { type: 'text', delta: 'b' },
          ],
        },
      ],
    });
    const out: ChatEvent[] = [];
    for await (const e of provider.chat(request({ signal: controller.signal }))) {
      out.push(e);
      controller.abort();
    }
    expect(out).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'stop', reason: 'cancelled' },
    ]);
  });

  it('throws when the script is exhausted', async () => {
    const provider = new MockProvider();
    await expect(events(provider.chat(request()))).rejects.toThrow(/exhausted/);
  });
});

describe('ProviderError', () => {
  it('defaults retryable by kind', () => {
    expect(new ProviderError('rateLimit', 'x').retryable).toBe(true);
    expect(new ProviderError('server', 'x').retryable).toBe(true);
    expect(new ProviderError('auth', 'x').retryable).toBe(false);
    expect(new ProviderError('auth', 'x', { retryable: true }).retryable).toBe(true);
  });

  it('is recognised structurally across module copies', () => {
    const lookalike = Object.assign(new Error('x'), {
      name: 'ProviderError',
      kind: 'quota',
      retryable: false,
    });
    expect(isProviderError(lookalike)).toBe(true);
    expect(isProviderError(new Error('x'))).toBe(false);
  });
});
