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
  enabledApiProposals?: string[];
  contributes: {
    commands: { command: string }[];
    configuration: {
      properties: Record<
        string,
        { scope?: string; minimum?: number; maximum?: number; default?: unknown }
      >;
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

  test('declares the one proposed API it uses, and activates where it is not enabled', () => {
    // vscode.lm.fileIsIgnored (Copilot content exclusion); stable VS Code only enables it
    // with --enable-proposed-api, so the tests run without it.
    assert.deepStrictEqual(manifest.enabledApiProposals, ['chatParticipantAdditions']);
    assert.strictEqual(extension.isActive, true);
  });

  test('registers every contributed command', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const { command } of manifest.contributes.commands) {
      assert.ok(commands.includes(command), command);
    }
    // The scaffolding command is gone.
    assert.ok(!commands.includes('aiReview.hello'));
  });

  test('settings that limit spending are user settings only (F23)', () => {
    const properties = manifest.contributes.configuration.properties;
    for (const key of USER_ONLY_SETTINGS) {
      assert.strictEqual(properties[`aiReview.${key}`]?.scope, 'application', key);
    }
    // A repository's settings can't empty the list of files never to send.
    assert.ok(USER_ONLY_SETTINGS.includes('excludeFiles'));
    assert.deepStrictEqual(properties['aiReview.excludeFiles']?.default, []);
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
