import {
  PROVIDER_CONFORMANCE,
  ProviderError,
  collectChat,
  isProviderError,
  noopLogger,
  type ChatRequest,
  type ConformanceHarness,
  type ConformanceStep,
} from '@ai-review/core';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { VsCodeLmProvider, mapLmError, toLmMessages, toLmOptions } from '../src/providers/copilot';

const tool = { name: 'report_findings', description: 'Report', inputSchema: { type: 'object' } };
const other = { name: 'read_file', description: 'Read', inputSchema: { type: 'object' } };

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'm',
    system: [{ text: 'sys' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
    ...over,
  };
}

suite('VsCodeLmProvider mapping', () => {
  test('LanguageModelError codes map to clear ProviderErrors', () => {
    const consent = mapLmError(vscode.LanguageModelError.NoPermissions('denied'));
    assert.strictEqual(consent.kind, 'consent');
    assert.match(consent.message, /Allow/);
    assert.strictEqual(mapLmError(vscode.LanguageModelError.Blocked('limit')).kind, 'quota');
    assert.strictEqual(mapLmError(vscode.LanguageModelError.NotFound('gone')).kind, 'notFound');
    assert.strictEqual(mapLmError(new Error('Rate limit exceeded (429)')).kind, 'rateLimit');
    assert.strictEqual(mapLmError(new Error('Message exceeds token limit')).kind, 'contextTooLong');
  });

  test('other failures keep their kinds; ProviderErrors pass through', () => {
    const notFound = mapLmError(vscode.LanguageModelError.NotFound('gone'));
    assert.match(notFound.message, /no longer available/);
    assert.strictEqual(mapLmError(new Error('You exceeded your quota')).kind, 'quota');
    assert.strictEqual(mapLmError(new Error('fetch failed')).kind, 'network');
    const unknown = mapLmError(new Error('something odd'));
    assert.strictEqual(unknown.kind, 'unknown');
    assert.match(unknown.message, /something odd/);
    const own = new ProviderError('server', 'overloaded', { provider: 'copilot' });
    assert.strictEqual(mapLmError(own), own);
  });

  test('a Blocked error about a usage limit stops the review as quota', () => {
    for (const message of [
      'Quota exceeded',
      'You have reached your monthly limit of premium requests',
      'Rate limit exceeded',
      'Usage limit reached',
    ]) {
      const error = mapLmError(vscode.LanguageModelError.Blocked(message));
      assert.strictEqual(error.kind, 'quota', message);
      assert.match(error.message, /limit/);
    }
  });

  test('any other Blocked error fails only its part, without blaming a usage limit', () => {
    for (const message of [
      'Sorry, your request was filtered by the Responsible AI Service.',
      'Response contained content that violates the acceptable usage policy',
      '',
    ]) {
      const error = mapLmError(vscode.LanguageModelError.Blocked(message));
      assert.strictEqual(error.kind, 'blocked', message);
      assert.doesNotMatch(error.message, /limit/);
      assert.strictEqual(error.retryable, false);
    }
    const filtered = mapLmError(vscode.LanguageModelError.Blocked('filtered by content policy'));
    assert.match(filtered.message, /filtered by content policy/);
  });

  test('forced tool sends only that tool in Required mode', () => {
    const options = toLmOptions(
      req({ tools: [other, tool], toolChoice: { name: 'report_findings' } }),
    );
    assert.strictEqual(options.toolMode, vscode.LanguageModelChatToolMode.Required);
    assert.deepStrictEqual(
      options.tools?.map((t) => t.name),
      ['report_findings'],
    );
    assert.strictEqual(toLmOptions(req({ tools: [tool], toolChoice: 'none' })).tools, undefined);
    assert.strictEqual(toLmOptions(req({ tools: [tool, other] })).tools?.length, 2);
  });

  test('system text becomes the first user message; tool parts are mapped', () => {
    const messages = toLmMessages(
      req({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', callId: 'c1', content: 'nope', isError: true }],
          },
        ],
      }),
    );
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[0]?.role, vscode.LanguageModelChatMessageRole.User);
    assert.ok(messages[2]?.content[0] instanceof vscode.LanguageModelToolCallPart);
    const result = messages[3]?.content[0];
    assert.ok(result instanceof vscode.LanguageModelToolResultPart);
    assert.strictEqual(result.callId, 'c1');
  });
});

type FakePart = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;
/** One scripted vscode.lm response: `parts` streamed in order, then `error` thrown if set. */
type Reply = { parts: FakePart[]; error?: unknown; stall?: boolean } | { error: unknown };

/** A vscode.lm model that plays `replies`; token counts are string lengths (1 per message). */
function fakeModel(replies: Reply[]) {
  const sent: vscode.LanguageModelChatRequestOptions[] = [];
  const counted: string[] = [];
  const model = {
    id: 'gpt-test',
    name: 'GPT Test',
    vendor: 'copilot',
    family: 'test',
    version: '1',
    maxInputTokens: 10_000,
    async countTokens(input: string | vscode.LanguageModelChatMessage) {
      if (typeof input !== 'string') return 1;
      counted.push(input);
      return input.length;
    },
    async sendRequest(
      _messages: vscode.LanguageModelChatMessage[],
      options: vscode.LanguageModelChatRequestOptions,
      token: vscode.CancellationToken,
    ) {
      sent.push(options);
      const reply = replies.shift() ?? { error: new Error('no more replies') };
      if (!('parts' in reply)) throw reply.error;
      const { parts, stall, error } = reply;
      async function* stream() {
        for (const part of parts) yield part;
        if (stall && !token.isCancellationRequested) {
          await new Promise<void>((resolve) => token.onCancellationRequested(() => resolve()));
        }
        if (error) throw error;
      }
      return { stream: stream(), text: (async function* () {})() };
    },
  };
  return { model: model as unknown as vscode.LanguageModelChat, sent, counted };
}

function copilot(replies: Reply[]) {
  const fake = fakeModel(replies);
  const options = { selectModels: async () => [fake.model], retry: { sleep: async () => {} } };
  return { ...fake, provider: new VsCodeLmProvider(noopLogger, options) };
}

const text = (value: string) => new vscode.LanguageModelTextPart(value);
const rateLimit = () => new Error('Rate limit exceeded (429)');

suite('VsCodeLmProvider chat', () => {
  test('streams text and tool calls, then the message, estimated usage and stop', async () => {
    const call = new vscode.LanguageModelToolCallPart('c1', 'report_findings', { findings: [] });
    const { provider } = copilot([{ parts: [text('Hel'), text('lo'), call] }]);
    const res = await collectChat(provider.chat(req({ model: 'gpt-test' })));
    assert.strictEqual(res.text, 'Hello');
    assert.deepStrictEqual(res.toolCalls, [
      { id: 'c1', name: 'report_findings', input: { findings: [] } },
    ]);
    assert.deepStrictEqual(
      res.message.map((p) => p.type),
      ['text', 'tool_call'],
    );
    assert.strictEqual(res.stopReason, 'tool_use');
    assert.strictEqual(res.usage.estimated, true);
    assert.strictEqual(res.usage.requests, 1);
    assert.strictEqual(res.usage.inputTokens, 2);
  });

  test('a plain answer ends with stop: end', async () => {
    const { provider } = copilot([{ parts: [text('fine')] }]);
    const res = await collectChat(provider.chat(req()));
    assert.strictEqual(res.stopReason, 'end');
    assert.strictEqual(res.text, 'fine');
  });

  test('blocked, quota, consent and notFound failures are not retried', async () => {
    const cases: [unknown, string][] = [
      [vscode.LanguageModelError.Blocked('filtered by content policy'), 'blocked'],
      [vscode.LanguageModelError.Blocked('Quota exceeded'), 'quota'],
      [vscode.LanguageModelError.NoPermissions('denied'), 'consent'],
      [vscode.LanguageModelError.NotFound('gone'), 'notFound'],
    ];
    for (const [error, kind] of cases) {
      const { provider, sent } = copilot([{ error }, { parts: [text('ok')] }]);
      await assert.rejects(
        collectChat(provider.chat(req())),
        (err) => isProviderError(err) && err.kind === kind,
      );
      assert.strictEqual(sent.length, 1, kind);
    }
  });

  test('a rate limit after text was streamed is not retried', async () => {
    const { provider, sent } = copilot([{ parts: [text('par')], error: rateLimit() }]);
    await assert.rejects(
      collectChat(provider.chat(req())),
      (err) => isProviderError(err) && err.kind === 'rateLimit',
    );
    assert.strictEqual(sent.length, 1);
  });

  test('cancelling while streaming ends with stop: cancelled', async () => {
    const { provider } = copilot([{ parts: [text('partial')], stall: true }]);
    const controller = new AbortController();
    const res = await collectChat(provider.chat(req({ signal: controller.signal })), () =>
      controller.abort(),
    );
    assert.strictEqual(res.stopReason, 'cancelled');
  });

  test('a transient rate limit is retried', async () => {
    const { provider, sent } = copilot([{ error: rateLimit() }, { parts: [text('ok')] }]);
    const res = await collectChat(provider.chat(req()));
    assert.strictEqual(res.text, 'ok');
    assert.strictEqual(res.stopReason, 'end');
    assert.strictEqual(sent.length, 2);
  });

  test('input usage counts the tool definitions', async () => {
    const plain = await collectChat(copilot([{ parts: [text('ok')] }]).provider.chat(req()));
    const fake = copilot([{ parts: [text('ok')] }]);
    const res = await collectChat(
      fake.provider.chat(req({ tools: [tool], toolChoice: { name: 'report_findings' } })),
    );
    const schema = JSON.stringify(tool.inputSchema);
    assert.ok(
      res.usage.inputTokens >= plain.usage.inputTokens + schema.length,
      `input ${res.usage.inputTokens} should include the tool definitions`,
    );
    assert.ok(fake.counted.some((s) => s.includes(tool.description) && s.includes(schema)));
  });
});

suite('VsCodeLmProvider conformance', () => {
  /** vscode.lm errors as the Copilot extension raises them. */
  const errors = {
    rateLimit,
    blocked: () => vscode.LanguageModelError.Blocked('filtered by content policy'),
    quota: () => vscode.LanguageModelError.Blocked('Quota exceeded'),
    auth: () => vscode.LanguageModelError.NoPermissions('denied'),
  };
  const toReply = (step: ConformanceStep): Reply => {
    switch (step.kind) {
      case 'fail':
        return { error: errors[step.error]() };
      case 'failAfter':
        return { parts: [text(step.text)], error: rateLimit() };
      case 'stall':
        return { parts: [text(step.text)], stall: true };
      default:
        // vscode.lm has no stop reason: a cut-off answer looks like a finished one.
        return { parts: [text(step.text)] };
    }
  };
  const harness: ConformanceHarness = {
    model: 'gpt-test',
    reportsTruncation: false,
    create(steps) {
      const fake = copilot(steps.map(toReply));
      return { provider: fake.provider, requests: () => fake.sent.length };
    },
  };

  for (const c of PROVIDER_CONFORMANCE) test(c.name, () => c.run(harness));
});
