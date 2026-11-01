import { describe, expect, it } from 'vitest';
import { collectChat } from '../provider/collect';
import type { Message, ToolDef } from '../provider/types';
import { AnthropicProvider } from './provider';

// Real API call: costs a little money. Run with `pnpm test:live`.
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_LIVE_MODEL ?? 'claude-opus-5-5';

const addTool: ToolDef = {
  name: 'add_numbers',
  description: 'Adds two integers and returns the sum.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};

describe.skipIf(!apiKey)('AnthropicProvider (live)', () => {
  it('completes a tool-call round trip and reports usage', async () => {
    const provider = new AnthropicProvider({ apiKey });
    const signal = new AbortController().signal;
    const system = [
      { text: 'You are a terse assistant. Always use the provided tools for arithmetic.' },
    ];
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'What is 17 + 25? Use add_numbers.' }] },
    ];

    const first = await collectChat(
      provider.chat({
        model,
        system,
        messages,
        tools: [addTool],
        toolChoice: { name: 'add_numbers' },
        maxOutputTokens: 4000,
        signal,
      }),
    );
    expect(first.stopReason).toBe('tool_use');
    const call = first.toolCalls[0];
    expect(call?.name).toBe('add_numbers');
    const input = call?.input as { a: number; b: number };
    expect(input.a + input.b).toBe(42);
    expect(first.usage.inputTokens).toBeGreaterThan(0);
    expect(first.usage.outputTokens).toBeGreaterThan(0);

    messages.push({ role: 'assistant', content: first.message });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', callId: call!.id, content: '42' }],
    });

    const second = await collectChat(
      provider.chat({ model, system, messages, tools: [addTool], maxOutputTokens: 4000, signal }),
    );
    expect(second.stopReason).toBe('end');
    expect(second.text).toContain('42');
    expect(second.usage.requests).toBe(1);
  });
});
