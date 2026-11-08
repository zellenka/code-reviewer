import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockProvider, mockText, mockToolCall, type MockStep } from '../provider/mock';
import type { ChatEvent, ContentPart, ModelInfo, ToolDef } from '../provider/types';
import { runAgentLoop, type AgentLoopOptions, type AgentTool } from './loop';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
};

const FINAL: ToolDef = { name: 'done', description: 'finish', inputSchema: { type: 'object' } };

const echo: AgentTool<{ text: string }> = {
  def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
  schema: z.object({ text: z.string() }),
  run: async ({ text }) => `echo: ${text}`,
};
const boom: AgentTool<Record<string, never>> = {
  def: { name: 'boom', description: 'fails', inputSchema: { type: 'object' } },
  schema: z.object({}),
  run: async () => {
    throw new Error('disk on fire');
  },
};
const big: AgentTool<Record<string, never>> = {
  def: { name: 'big', description: 'large output', inputSchema: { type: 'object' } },
  schema: z.object({}),
  run: async () => 'x'.repeat(5_000),
};

function options(provider: MockProvider, over: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    provider,
    model: MODEL,
    system: [{ text: 'sys', cache: true }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [echo, boom, big] as unknown as AgentTool<never>[],
    finalTool: FINAL,
    checkFinal: (inputs) =>
      (inputs[0] as { ok?: boolean })?.ok ? { ok: true } : { ok: false, error: 'need ok' },
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
    ...over,
  };
}

const done = (input: unknown = { ok: true }) => mockToolCall('done', input);
/** The tool_result parts of the last user message of a request. */
const results = (p: MockProvider, i: number) =>
  p.requests[i]!.messages.at(-1)!.content.filter(
    (c): c is Extract<ContentPart, { type: 'tool_result' }> => c.type === 'tool_result',
  );

describe('runAgentLoop', () => {
  it('runs tool round trips until the final tool is called', async () => {
    const provider = new MockProvider({
      script: [mockToolCall('echo', { text: 'hi' }, { id: 'c1' }), done()],
    });
    const result = await runAgentLoop(options(provider));
    expect(result).toMatchObject({ stop: 'final', turns: 2, toolCalls: 1, final: [{ ok: true }] });
    expect(results(provider, 1)).toEqual([
      expect.objectContaining({ callId: 'c1', content: 'echo: hi' }),
    ]);
    // Same tools on every request (prompt cache), auto choice while exploring.
    expect(provider.requests.map((r) => r.tools!.map((t) => t.name))).toEqual([
      ['echo', 'boom', 'big', 'done'],
      ['echo', 'boom', 'big', 'done'],
    ]);
    expect(provider.requests[0]!.toolChoice).toBe('auto');
    expect(result.usage.requests).toBe(2);
  });

  it('runs parallel calls in one turn and answers each', async () => {
    const twoCalls: MockStep = {
      events: [
        { type: 'tool_call', id: 'a', name: 'echo', input: { text: '1' } },
        { type: 'tool_call', id: 'b', name: 'echo', input: { text: '2' } },
      ] satisfies ChatEvent[],
    };
    const provider = new MockProvider({ script: [twoCalls, done()] });
    const result = await runAgentLoop(options(provider));
    expect(result.toolCalls).toBe(2);
    expect(results(provider, 1).map((r) => r.content)).toEqual(['echo: 1', 'echo: 2']);
  });

  it('returns malformed input, unknown tools and tool failures as error results', async () => {
    const provider = new MockProvider({
      script: [
        mockToolCall('echo', { text: 42 }, { id: 'bad' }),
        mockToolCall('nope', {}, { id: 'unknown' }),
        mockToolCall('boom', {}, { id: 'fail' }),
        done(),
      ],
    });
    const result = await runAgentLoop(options(provider));
    expect(result.stop).toBe('final');
    expect(results(provider, 1)[0]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/invalid input: text/),
    });
    expect(results(provider, 2)[0]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/unknown tool/),
    });
    expect(results(provider, 3)[0]).toMatchObject({
      isError: true,
      content: 'Error: disk on fire',
    });
  });

  it('truncates large tool results', async () => {
    const provider = new MockProvider({ script: [mockToolCall('big', {}), done()] });
    await runAgentLoop(options(provider, { limits: { maxResultChars: 100 } }));
    const content = results(provider, 1)[0]!.content;
    expect(content.length).toBeLessThan(250);
    expect(content).toMatch(/truncated: 4900 more characters/);
  });

  it('wraps up at the turn limit by forcing the final tool', async () => {
    const provider = new MockProvider({
      script: [mockToolCall('echo', { text: '1' }), mockToolCall('echo', { text: '2' }), done()],
    });
    const result = await runAgentLoop(options(provider, { limits: { maxTurns: 2 } }));
    expect(result).toMatchObject({ stop: 'final', wrapUp: 'maxTurns', turns: 3 });
    expect(provider.requests[2]!.toolChoice).toEqual({ name: 'done' });
    expect(JSON.stringify(provider.requests[2]!.messages.at(-1))).toMatch(/last exploring turn/);
  });

  it('stops at the tool call limit and does not run extra calls', async () => {
    const three: MockStep = {
      events: ['a', 'b', 'c'].map((id): ChatEvent => ({
        type: 'tool_call',
        id,
        name: 'echo',
        input: { text: id },
      })),
    };
    const provider = new MockProvider({ script: [three, done()] });
    const result = await runAgentLoop(options(provider, { limits: { maxToolCalls: 2 } }));
    expect(result).toMatchObject({ toolCalls: 2, wrapUp: 'maxToolCalls', stop: 'final' });
    expect(results(provider, 1).map((r) => r.isError ?? false)).toEqual([false, false, true]);
  });

  it('stops when the token budget is used up', async () => {
    const provider = new MockProvider({ script: [mockToolCall('big', {}), done()] });
    const result = await runAgentLoop(options(provider, { limits: { tokenBudget: 500 } }));
    expect(result).toMatchObject({ wrapUp: 'tokenBudget', stop: 'final', turns: 2 });
    expect(provider.requests[1]!.toolChoice).toEqual({ name: 'done' });
  });

  it('gives up if the model keeps exploring after being told to finish', async () => {
    const provider = new MockProvider({ fallback: mockToolCall('echo', { text: 'again' }) });
    const result = await runAgentLoop(options(provider, { limits: { maxTurns: 1 } }));
    expect(result.stop).toBe('noFinal');
    expect(result.turns).toBeLessThanOrEqual(4);
  });

  it('asks once for the final tool when the model answers in text', async () => {
    const provider = new MockProvider({ script: [mockText('looks fine'), done()] });
    const result = await runAgentLoop(options(provider));
    expect(result).toMatchObject({ stop: 'final', wrapUp: 'noToolCall' });
    const fallback = new MockProvider({ fallback: mockText('still prose') });
    expect((await runAgentLoop(options(fallback))).stop).toBe('noFinal');
    expect(fallback.requests).toHaveLength(2);
  });

  it('repairs an invalid final input once, then gives up', async () => {
    const provider = new MockProvider({ script: [done({ ok: false }), done({ ok: true })] });
    const repaired = await runAgentLoop(options(provider));
    expect(repaired).toMatchObject({ stop: 'final', rejected: [{ ok: false }] });
    expect(results(provider, 1)[0]).toMatchObject({ isError: true, content: 'Error: need ok' });

    const stubborn = new MockProvider({ fallback: done({ ok: false }) });
    const result = await runAgentLoop(options(stubborn));
    expect(result.stop).toBe('invalidFinal');
    expect(stubborn.requests).toHaveLength(2);
  });

  it('stops on cancellation', async () => {
    const controller = new AbortController();
    const provider = new MockProvider({
      fallback: (req) => {
        controller.abort();
        return mockToolCall('echo', { text: String(req.messages.length) });
      },
    });
    const result = await runAgentLoop(options(provider, { signal: controller.signal }));
    expect(result.stop).toBe('cancelled');
  });

  it('moves one cache hint to the newest message each turn', async () => {
    const provider = new MockProvider({
      script: [mockToolCall('echo', { text: '1' }), mockToolCall('echo', { text: '2' }), done()],
    });
    // The first message has a shared-prefix hint of its own, which is kept.
    const shared = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'index', cache: true },
        { type: 'text' as const, text: 'diff' },
      ],
    };
    await runAgentLoop(options(provider, { messages: [shared] }));
    const hints = (i: number) =>
      provider.requests[i]!.messages.flatMap((m, mi) =>
        m.content.flatMap((p, pi) => ('cache' in p && p.cache ? [`${mi}.${pi}`] : [])),
      );
    expect(hints(0)).toEqual(['0.0', '0.1']);
    expect(hints(1)).toEqual(['0.0', '2.0']);
    expect(hints(2)).toEqual(['0.0', '4.0']);
    expect(shared.content[1]).not.toHaveProperty('cache');
  });
});
