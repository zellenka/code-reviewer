import { ProviderError, type ProviderErrorKind, type ProviderErrorOptions } from './errors';
import { estimateTokens } from './usage';
import type { ChatEvent, ChatRequest, ContentPart, LLMProvider, ModelInfo } from './types';

/**
 * One scripted response:
 * - `events`: streamed in order (a `message`, `usage` and `stop` are added if missing),
 *   then `error` is thrown if set (simulates a failure mid-stream)
 * - `error` only: thrown before any event
 * - a function: computes the step from the request
 */
export type MockStep =
  | { events: ChatEvent[]; error?: ProviderError; delayMs?: number }
  | { error: ProviderError }
  | ((req: ChatRequest) => MockStep);

export interface MockProviderOptions {
  id?: string;
  models?: ModelInfo[];
  script?: MockStep[];
  /** Used when the script is exhausted. Default: throw. */
  fallback?: MockStep;
}

export const MOCK_MODEL: ModelInfo = {
  id: 'mock-model',
  name: 'Mock Model',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
};

/** Deterministic provider for tests: replays a script of responses and records requests. */
export class MockProvider implements LLMProvider {
  readonly id: string;
  readonly requests: ChatRequest[] = [];
  private readonly models: ModelInfo[];
  private readonly script: MockStep[];
  private readonly fallback: MockStep | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.models = options.models ?? [MOCK_MODEL];
    this.script = [...(options.script ?? [])];
    this.fallback = options.fallback;
  }

  /** Appends steps to the script. */
  enqueue(...steps: MockStep[]): this {
    this.script.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.script.length;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async countTokens(_model: string, text: string): Promise<number> {
    return estimateTokens(text);
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    let step = this.script.shift() ?? this.fallback;
    if (!step) throw new Error(`MockProvider(${this.id}): script exhausted`);
    while (typeof step === 'function') step = step(req);

    if (!('events' in step)) throw step.error;

    const events = step.events;
    let sawMessage = false;
    let sawUsage = false;
    let toolUse = false;
    const text: string[] = [];
    const toolCalls: ContentPart[] = [];

    for (const event of events) {
      if (req.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (event.type === 'stop') break; // re-emitted below, after message/usage
      if (event.type === 'text') text.push(event.delta);
      if (event.type === 'tool_call') {
        toolUse = true;
        toolCalls.push({ ...event });
      }
      if (event.type === 'message') sawMessage = true;
      if (event.type === 'usage') sawUsage = true;
      yield event;
    }
    if (step.error) throw step.error;
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }

    if (!sawMessage) {
      const joined = text.join('');
      yield {
        type: 'message',
        content: [...(joined ? [{ type: 'text' as const, text: joined }] : []), ...toolCalls],
      };
    }
    if (!sawUsage) {
      const input = req.system.map((s) => s.text).join('') + JSON.stringify(req.messages);
      yield {
        type: 'usage',
        usage: {
          inputTokens: estimateTokens(input),
          outputTokens: estimateTokens(text.join('') + JSON.stringify(toolCalls)),
          requests: 1,
        },
      };
    }
    const stop = events.find((e) => e.type === 'stop');
    yield stop ?? { type: 'stop', reason: toolUse ? 'tool_use' : 'end' };
  }
}

/** Step that streams `text`, optionally split into chunks. */
export function mockText(text: string, chunkSize = Infinity): MockStep {
  const events: ChatEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push({ type: 'text', delta: text.slice(i, i + chunkSize) });
  }
  return { events };
}

let callCounter = 0;

/** Step that makes one tool call, with optional leading text. */
export function mockToolCall(
  name: string,
  input: unknown,
  options: { id?: string; text?: string } = {},
): MockStep {
  const id = options.id ?? `mock_call_${++callCounter}`;
  return {
    events: [
      ...(options.text ? [{ type: 'text' as const, delta: options.text }] : []),
      { type: 'tool_call', id, name, input },
    ],
  };
}

/** Step that fails before streaming anything. */
export function mockError(
  kind: ProviderErrorKind,
  message = `mock ${kind} error`,
  options?: ProviderErrorOptions,
): MockStep {
  return { error: new ProviderError(kind, message, { provider: 'mock', ...options }) };
}
