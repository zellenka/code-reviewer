import { describe, expect, it } from 'vitest';
import { collectChat } from './collect';
import { ProviderError } from './errors';
import { MockProvider, mockError, mockText } from './mock';
import { withRetry } from './retry';
import type { ChatRequest } from './types';
import { addUsage, estimateCostUsd } from './usage';

const req: ChatRequest = {
  model: 'm',
  system: [],
  messages: [],
  signal: new AbortController().signal,
};

function setup(...script: ConstructorParameters<typeof MockProvider>[0][]) {
  const provider = new MockProvider(script[0]);
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { provider, waits, sleep };
}

describe('withRetry', () => {
  it('retries retryable errors with exponential backoff', async () => {
    const { provider, waits, sleep } = setup({
      script: [mockError('rateLimit'), mockError('server'), mockText('ok')],
    });
    const res = await collectChat(
      withRetry(() => provider.chat(req), { sleep, random: () => 0.5 }),
    );
    expect(res.text).toBe('ok');
    expect(waits).toEqual([1000, 2000]);
  });

  it('honours retryAfterMs', async () => {
    const { provider, waits, sleep } = setup({
      script: [mockError('rateLimit', 'slow down', { retryAfterMs: 4321 }), mockText('ok')],
    });
    await collectChat(withRetry(() => provider.chat(req), { sleep }));
    expect(waits).toEqual([4321]);
  });

  it('fails instead of waiting longer than maxDelayMs', async () => {
    const { provider, waits, sleep } = setup({
      script: [mockError('rateLimit', 'slow down', { retryAfterMs: 120_000 }), mockText('ok')],
    });
    await expect(collectChat(withRetry(() => provider.chat(req), { sleep }))).rejects.toMatchObject(
      {
        kind: 'rateLimit',
        retryable: false,
      },
    );
    expect(waits).toEqual([]);
  });

  it('does not retry non-retryable errors', async () => {
    const { provider, sleep } = setup({ script: [mockError('auth'), mockText('ok')] });
    await expect(collectChat(withRetry(() => provider.chat(req), { sleep }))).rejects.toMatchObject(
      { kind: 'auth' },
    );
    expect(provider.requests).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const { provider, sleep } = setup({ fallback: mockError('network') });
    await expect(
      collectChat(withRetry(() => provider.chat(req), { sleep, maxRetries: 2 })),
    ).rejects.toMatchObject({
      kind: 'network',
    });
    expect(provider.requests).toHaveLength(3);
  });

  it('does not retry after output was streamed', async () => {
    const { provider, sleep } = setup({
      script: [
        { events: [{ type: 'text', delta: 'half' }], error: new ProviderError('network', 'reset') },
        mockText('ok'),
      ],
    });
    await expect(collectChat(withRetry(() => provider.chat(req), { sleep }))).rejects.toMatchObject(
      { kind: 'network' },
    );
    expect(provider.requests).toHaveLength(1);
  });

  it('stops waiting when cancelled', async () => {
    const controller = new AbortController();
    const { provider } = setup({ script: [mockError('server'), mockText('ok')] });
    const sleep = async () => controller.abort();
    const res = await collectChat(
      withRetry(() => provider.chat(req), { sleep, signal: controller.signal }),
    );
    expect(res.stopReason).toBe('cancelled');
    expect(provider.requests).toHaveLength(1);
  });
});

describe('usage', () => {
  it('adds usage and prices it', () => {
    const total = addUsage(
      { inputTokens: 1_000_000, outputTokens: 0, requests: 1 },
      {
        inputTokens: 0,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        requests: 1,
        estimated: true,
      },
    );
    expect(total).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      requests: 2,
      estimated: true,
    });
    expect(
      estimateCostUsd(total, { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 }),
    ).toBeCloseTo(6.2);
  });
});
