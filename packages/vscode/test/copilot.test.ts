import { ProviderError, type ChatRequest } from '@ai-review/core';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { mapLmError, toLmMessages, toLmOptions } from '../src/providers/copilot';

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
