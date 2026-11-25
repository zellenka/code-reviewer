import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { targetFor } from '../src/providers/registry';
import { AGENT_LIMIT_SETTINGS, USER_ONLY_SETTINGS } from '../src/settings';
// Read the id from the manifest so changing the publisher doesn't break tests.
// Compiled to out/test/, so the manifest is two levels up.
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  name: string;
  publisher: string;
  contributes: {
    configuration: {
      properties: Record<string, { scope?: string; minimum?: number; maximum?: number }>;
    };
  };
};
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

  test('settings that limit spending are user settings only (F23)', () => {
    const properties = manifest.contributes.configuration.properties;
    for (const key of USER_ONLY_SETTINGS) {
      assert.strictEqual(properties[`aiReview.${key}`]?.scope, 'application', key);
    }
    for (const { key, min, max } of Object.values(AGENT_LIMIT_SETTINGS)) {
      assert.strictEqual(properties[`aiReview.${key}`]?.minimum, min, key);
      assert.strictEqual(properties[`aiReview.${key}`]?.maximum, max, key);
    }
  });

  test('a repository may only set settings that change neither cost, scrutiny nor where code goes (A2)', () => {
    const properties = manifest.contributes.configuration.properties;
    const fromRepo = Object.keys(properties).filter((k) => properties[k]?.scope !== 'application');
    assert.deepStrictEqual(fromRepo.sort(), ['aiReview.baseBranch', 'aiReview.concurrency']);
    for (const key of [
      'provider',
      'model',
      'anthropic.refusalFallback',
      'reviewMode',
      'verifyFindings',
      'summary',
    ]) {
      assert.strictEqual(properties[`aiReview.${key}`]?.scope, 'application', key);
    }
  });

  test('user-only settings are written to user settings, even when a workspace sets them (A2)', () => {
    const inWorkspace = {
      inspect: (key: string) => ({ key, workspaceValue: 'x', workspaceFolderValue: 'y' }),
    } as unknown as vscode.WorkspaceConfiguration;
    for (const key of ['provider', 'model', 'reviewMode', 'verifyFindings', 'includeContext']) {
      assert.strictEqual(targetFor(inWorkspace, key), vscode.ConfigurationTarget.Global, key);
    }
    // Others still go where they are set, so a workspace value isn't silently shadowed.
    assert.strictEqual(
      targetFor(inWorkspace, 'baseBranch'),
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  });
});
