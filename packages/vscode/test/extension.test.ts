import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
// Read the id from the manifest so changing the publisher doesn't break tests.
// Compiled to out/test/, so the manifest is two levels up.
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { name: string; publisher: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

suite('Extension', () => {
  let extension: vscode.Extension<unknown>;

  suiteSetup(async () => {
    const found = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(found, `${EXTENSION_ID} not found`);
    extension = found;
    await extension.activate();
  });

  test('activates', () => {
    assert.strictEqual(extension.isActive, true);
  });

  test('registers aiReview.* commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('aiReview.hello'));
    assert.ok(commands.includes('aiReview.showLog'));
  });

  test('"AI Review: Hello" runs', async () => {
    const message = await vscode.commands.executeCommand<string>('aiReview.hello');
    assert.match(message, /Hello/);
  });
});
