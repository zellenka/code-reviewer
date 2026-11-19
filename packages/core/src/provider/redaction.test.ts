import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { buildSystemPrompt } from '../review/prompt';
import { buildSummarySystemPrompt } from '../review/summarize';
import { buildVerifySystemPrompt } from '../review/verify';
import { collectChat } from './collect';
import { MockProvider } from './mock';
import { withSecretRedaction } from './redaction';
import type { ChatRequest } from './types';

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
const KEY_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
const PEM = ['-----BEGIN PRIVATE KEY-----', KEY_BODY, KEY_BODY, '-----END PRIVATE KEY-----'];
const SECRET = new RegExp(`${AWS}|${GITHUB}|${KEY_BODY}`);

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'mock-model',
  system: [{ text: `You review code. Example key: ${AWS}` }, { text: 'Rules', cache: true }],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: `Review this.\n${PEM.join('\n')}\nconst t = '${GITHUB}';` }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `I saw ${AWS}.` },
        { type: 'tool_call', id: 'c1', name: 'search_code', input: { pattern: AWS } },
        { type: 'opaque', provider: 'anthropic', data: { thinking: AWS, signature: 'sig' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', callId: 'c1', content: `src/a.ts:1: ${GITHUB}`, cache: true },
      ],
    },
  ],
  tools: [{ name: 'search_code', description: `e.g. ${AWS}`, inputSchema: { type: 'object' } }],
  signal: new AbortController().signal,
  ...over,
});

const sentBy = async (req: ChatRequest) => {
  const mock = new MockProvider({ fallback: { events: [{ type: 'text', delta: 'ok' }] } });
  await collectChat(withSecretRedaction(mock).chat(req));
  return mock.requests[0]!;
};

describe('withSecretRedaction (A1)', () => {
  it('redacts known secrets in system blocks, message text and tool results', async () => {
    const sent = await sentBy(request());
    const outgoing = JSON.stringify({ system: sent.system, messages: sent.messages });
    // What the provider sends that the conversation protocol doesn't fix.
    const text = JSON.stringify([
      sent.system,
      sent.messages.flatMap((m) =>
        m.content.filter((p) => p.type === 'text' || p.type === 'tool_result'),
      ),
    ]);
    expect(text).not.toMatch(SECRET);
    expect(outgoing).toContain('[REDACTED:aws-access-key]');
    expect(outgoing).toContain('[REDACTED:github-token]');
    expect(outgoing).toContain('[REDACTED:private-key]');
    // Cache hints and the shape of the conversation stay.
    expect(sent.system.map((b) => b.cache)).toEqual([undefined, true]);
    expect(sent.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', cache: true });
  });

  it("leaves the model's tool calls, provider data and tool definitions as they are", async () => {
    const req = request();
    const sent = await sentBy(req);
    const assistant = sent.messages[1]!.content;
    expect(assistant[1]).toEqual(req.messages[1]!.content[1]);
    expect(assistant[2]).toEqual(req.messages[1]!.content[2]);
    expect(sent.tools).toBe(req.tools);
    expect(sent.signal).toBe(req.signal);
  });

  it('passes normal text and redaction placeholders through unchanged', async () => {
    const clean: ChatRequest = {
      model: 'mock-model',
      system: [
        { text: buildSystemPrompt({ config: DEFAULT_CONFIG }) },
        {
          text: buildSystemPrompt({
            config: DEFAULT_CONFIG,
            agent: { maxTurns: 8, maxToolCalls: 20 },
            jsonOnly: true,
          }),
        },
        { text: buildVerifySystemPrompt(DEFAULT_CONFIG) },
        { text: buildSummarySystemPrompt(DEFAULT_CONFIG), cache: true },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                "const key = '[REDACTED:aws-access-key]';",
                'password = "[REDACTED:secret]"',
                'url = postgres://admin:[REDACTED:connection-string-password]@db:5432/x',
                'Authorization: Bearer [REDACTED:bearer-token]',
                '-----BEGIN PRIVATE KEY-----',
                '[REDACTED:private-key]',
                '-----END PRIVATE KEY-----',
                'const tokenCount = getTokenCount();',
              ].join('\n'),
            },
          ],
        },
      ],
      signal: new AbortController().signal,
    };
    const sent = await sentBy(clean);
    expect(sent.system).toEqual(clean.system);
    expect(sent.messages).toEqual(clean.messages);
  });

  it('a BEGIN marker without an END does not hide the rest of the text', async () => {
    const text = [
      "if (pem.startsWith('-----BEGIN RSA PRIVATE KEY-----')) {",
      '  return parse(pem);',
      '}',
      `const id = '${AWS}';`,
    ].join('\n');
    const sent = await sentBy(
      request({
        system: [{ text: 'sys' }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      }),
    );
    expect((sent.messages[0]!.content[0] as { text: string }).text).toBe(
      text.replace(AWS, '[REDACTED:aws-access-key]'),
    );
  });

  it('sends the same text for the same request, so cached prefixes still match', async () => {
    const req = request();
    const a = await sentBy(req);
    const b = await sentBy(request());
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    // The caller's request is not changed.
    expect(JSON.stringify(req.messages)).toContain(GITHUB);
  });

  it('keeps the id, models and token counts of the provider, and wraps it once', async () => {
    const mock = new MockProvider({ id: 'copilot' });
    const wrapped = withSecretRedaction(mock);
    expect(wrapped.id).toBe('copilot');
    expect(await wrapped.listModels()).toEqual(await mock.listModels());
    expect(await wrapped.countTokens('m', 'abcd')).toBe(await mock.countTokens('m', 'abcd'));
    expect(withSecretRedaction(wrapped)).toBe(wrapped);
  });
});
