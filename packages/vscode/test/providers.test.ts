import { MockProvider, isProviderError, type ChatRequest, type MockStep } from '@ai-review/core';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import type { TestConnectionResult } from '../src/commands/testConnection';

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  name: string;
  publisher: string;
};
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const TEST_KEY = 'sk-ant-test-0000000000000000000000';

/** Answers the test-connection round trip: tool call first, then the sum. */
function roundTrip(req: ChatRequest): MockStep {
  const toolResult = req.messages.some((m) => m.content.some((p) => p.type === 'tool_result'));
  return toolResult
    ? { events: [{ type: 'text', delta: '42' }] }
    : {
        events: [{ type: 'tool_call', id: 'call_1', name: 'add_numbers', input: { a: 17, b: 25 } }],
      };
}

function stubModel(id: string) {
  return {
    id,
    name: `Stub ${id}`,
    vendor: 'copilot',
    maxInputTokens: 10_000,
    maxOutputTokens: 1_000,
    supportsTools: true,
  };
}

suite('Providers', () => {
  let api: ExtensionApi;
  const disposables: vscode.Disposable[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
    assert.ok(extension);
    api = await extension.activate();
  });

  teardown(async () => {
    vscode.Disposable.from(...disposables.splice(0)).dispose();
    const config = vscode.workspace.getConfiguration('aiReview');
    await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
    await config.update('model', undefined, vscode.ConfigurationTarget.Global);
    await api.keyStore.clear();
  });

  test('registers provider commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'selectModel',
      'testConnection',
      'setAnthropicApiKey',
      'clearAnthropicApiKey',
    ]) {
      assert.ok(commands.includes(`aiReview.${id}`), id);
    }
  });

  test('the chosen model is used by the next request, without reload', async () => {
    const stub = new MockProvider({
      id: 'copilot',
      models: [stubModel('m1'), stubModel('m2')],
      fallback: roundTrip,
    });
    disposables.push(
      api.registry.register('copilot', {
        label: 'Stub Copilot',
        provider: stub,
        isAvailable: () => true,
      }),
    );

    await vscode.commands.executeCommand('aiReview.selectModel', {
      providerId: 'copilot',
      modelId: 'm2',
    });
    assert.strictEqual(vscode.workspace.getConfiguration('aiReview').get('model'), 'm2');

    const result = await vscode.commands.executeCommand<TestConnectionResult>(
      'aiReview.testConnection',
      { silent: true },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.modelId, 'm2');
    assert.strictEqual(result.reply, '42');
    assert.deepStrictEqual(
      stub.requests.map((r) => r.model),
      ['m2', 'm2'],
    );

    await vscode.commands.executeCommand('aiReview.selectModel', {
      providerId: 'copilot',
      modelId: 'm1',
    });
    await vscode.commands.executeCommand('aiReview.testConnection', { silent: true });
    assert.strictEqual(stub.requests.at(-1)?.model, 'm1');
  });

  test('an unknown model gives a notFound error', async () => {
    const stub = new MockProvider({ id: 'copilot', models: [stubModel('m1')] });
    disposables.push(
      api.registry.register('copilot', {
        label: 'Stub Copilot',
        provider: stub,
        isAvailable: () => true,
      }),
    );
    await vscode.commands.executeCommand('aiReview.selectModel', {
      providerId: 'copilot',
      modelId: 'gone',
    });
    await assert.rejects(
      api.registry.resolveActive(),
      (err) => isProviderError(err) && err.kind === 'notFound',
    );
  });

  test('Anthropic key lives in SecretStorage, not settings', async () => {
    await vscode.commands.executeCommand('aiReview.selectModel', {
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
    });
    await assert.rejects(
      api.registry.resolveActive(),
      (err) => isProviderError(err) && err.kind === 'auth' && err.provider === 'anthropic',
    );

    await vscode.commands.executeCommand('aiReview.setAnthropicApiKey', TEST_KEY);
    assert.strictEqual(api.keyStore.hasKey, true);
    assert.strictEqual(await api.keyStore.get(), TEST_KEY);
    const active = await api.registry.resolveActive();
    assert.strictEqual(active.model.id, 'claude-opus-5-5');

    const config = vscode.workspace.getConfiguration('aiReview');
    const allValues = JSON.stringify(
      ['provider', 'model', 'anthropic'].map((k) => config.inspect(k)),
    );
    assert.ok(!allValues.includes(TEST_KEY), 'API key must not appear in settings');

    await vscode.commands.executeCommand('aiReview.clearAnthropicApiKey');
    assert.strictEqual(api.keyStore.hasKey, false);
  });
});
