import { isProviderError, type ProviderError } from './errors';
import type { ChatEvent, ChatRequest, LLMProvider } from './types';

/**
 * One scripted backend response, described independently of the provider.
 * Each provider's tests turn it into the backend's own shapes and errors.
 */
export type ConformanceStep =
  /** Streams `text` and finishes normally. */
  | { kind: 'reply'; text: string }
  /** Streams `text`, then stops at the output limit (if the backend can say so). */
  | { kind: 'truncated'; text: string }
  /** Streams `text`, then waits until the request is cancelled. */
  | { kind: 'stall'; text: string }
  /** Streams `text`, then fails with a rate limit. */
  | { kind: 'failAfter'; text: string }
  /** Fails before any output. `auth` is whatever the backend uses for "not allowed". */
  | { kind: 'fail'; error: 'rateLimit' | 'blocked' | 'quota' | 'auth' };

export interface ConformanceHarness {
  /**
   * A provider whose backend answers requests with `steps`, in order, and
   * the number of backend requests made so far. Retry waits must be instant.
   */
  create(steps: ConformanceStep[]): { provider: LLMProvider; requests(): number };
  model: string;
  /** False when the backend can't report a cut-off answer (vscode.lm). */
  reportsTruncation: boolean;
}

export interface ConformanceCase {
  name: string;
  run(harness: ConformanceHarness): Promise<void>;
}

/**
 * Behaviour every LLMProvider must share: cancellation, retry, failures and
 * truncation. Framework-free (throws on failure) so both the vitest and the
 * VS Code test suites can run it against their providers.
 */
export const PROVIDER_CONFORMANCE: readonly ConformanceCase[] = [
  {
    name: 'cancelled before the request: stop cancelled, nothing sent',
    async run(h) {
      const { provider, requests } = h.create([{ kind: 'reply', text: 'ok' }]);
      const controller = new AbortController();
      controller.abort();
      const events = await drain(provider.chat(request(h, controller.signal)));
      check(events.at(-1)?.type === 'stop', 'ends with a stop event');
      expectStop(events, 'cancelled');
      check(requests() === 0, `no request is sent (sent ${requests()})`);
    },
  },
  {
    name: 'cancelled while streaming: stop cancelled, no error',
    async run(h) {
      const { provider } = h.create([{ kind: 'stall', text: 'partial' }]);
      const controller = new AbortController();
      const events = await drain(provider.chat(request(h, controller.signal)), (event) => {
        if (event.type === 'text') controller.abort();
      });
      expectStop(events, 'cancelled');
    },
  },
  {
    name: 'a transient rate limit is retried without duplicating output',
    async run(h) {
      const { provider, requests } = h.create([
        { kind: 'fail', error: 'rateLimit' },
        { kind: 'reply', text: 'ok' },
      ]);
      const events = await drain(provider.chat(request(h)));
      expectStop(events, 'end');
      check(textOf(events) === 'ok', `text is "ok" (got "${textOf(events)}")`);
      check(requests() === 2, `retried once (sent ${requests()})`);
    },
  },
  {
    name: 'a rate limit after output was streamed is not retried',
    async run(h) {
      const { provider, requests } = h.create([{ kind: 'failAfter', text: 'partial' }]);
      const error = await failure(provider.chat(request(h)));
      check(error.kind === 'rateLimit', `fails with rateLimit (got ${error.kind})`);
      check(requests() === 1, `not retried (sent ${requests()})`);
    },
  },
  {
    name: 'blocked, quota and auth failures fail at once without retry',
    async run(h) {
      for (const kind of ['blocked', 'quota', 'auth'] as const) {
        const { provider, requests } = h.create([
          { kind: 'fail', error: kind },
          { kind: 'reply', text: 'ok' },
        ]);
        const error = await failure(provider.chat(request(h)));
        const expected = kind === 'auth' ? ['auth', 'consent'] : [kind];
        check(expected.includes(error.kind), `${kind}: fails with ${kind} (got ${error.kind})`);
        check(!error.retryable, `${kind}: error is not retryable`);
        check(requests() === 1, `${kind}: not retried (sent ${requests()})`);
      }
    },
  },
  {
    name: 'a cut-off answer is reported as max_tokens only when the backend says so',
    async run(h) {
      const { provider } = h.create([{ kind: 'truncated', text: '{"findings": [' }]);
      const events = await drain(provider.chat(request(h)));
      expectStop(events, h.reportsTruncation ? 'max_tokens' : 'end');
      check(textOf(events) === '{"findings": [', 'the partial text is kept');
    },
  },
];

function request(h: ConformanceHarness, signal = new AbortController().signal): ChatRequest {
  return {
    model: h.model,
    system: [{ text: 'sys' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal,
  };
}

async function drain(
  stream: AsyncIterable<ChatEvent>,
  onEvent?: (event: ChatEvent) => void,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

async function failure(stream: AsyncIterable<ChatEvent>): Promise<ProviderError> {
  try {
    await drain(stream);
  } catch (err) {
    check(isProviderError(err), `throws a ProviderError (got ${String(err)})`);
    return err as ProviderError;
  }
  throw new Error('expected the request to fail');
}

function expectStop(events: ChatEvent[], reason: string): void {
  const stops = events.filter((e) => e.type === 'stop');
  check(stops.length === 1, `exactly one stop event (got ${stops.length})`);
  check(events.at(-1) === stops[0], 'stop is the last event');
  const actual = stops[0]?.type === 'stop' ? stops[0].reason : undefined;
  check(actual === reason, `stop: ${reason} (got ${actual})`);
}

function textOf(events: ChatEvent[]): string {
  return events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Provider conformance: ${message}`);
}
