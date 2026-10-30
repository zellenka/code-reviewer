import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'serhii.ai-code-reviewer';

suite('Extension', () => {
  test('is installed', () => {
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID), `${EXTENSION_ID} not found`);
  });

  test('"AI Review: Hello" activates the extension and runs', async () => {
    const message = await vscode.commands.executeCommand<string>('aiReview.hello');
    assert.match(message, /Hello/);
    assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  test('registers aiReview.* commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('aiReview.hello'));
    assert.ok(commands.includes('aiReview.showLog'));
  });
});
