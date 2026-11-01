import { AnthropicProvider, PRODUCT_NAME } from '@ai-review/core';
import * as vscode from 'vscode';
import { testConnectionCommand } from './commands/testConnection';
import { OutputChannelLogger } from './logger';
import { AnthropicKeyStore, clearApiKeyCommand, setApiKeyCommand } from './providers/apiKey';
import { VsCodeLmProvider } from './providers/copilot';
import { ModelStatusBar, selectModelCommand } from './providers/picker';
import { CONFIG_SECTION, ProviderRegistry, type Selection } from './providers/registry';

/** Returned from `activate`; used by extension tests. Not a stable public API. */
export interface ExtensionApi {
  registry: ProviderRegistry;
  keyStore: AnthropicKeyStore;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const logger = new OutputChannelLogger(PRODUCT_NAME);
  context.subscriptions.push(logger);
  logger.info(`${PRODUCT_NAME} activated (v${context.extension.packageJSON.version})`);

  const registry = new ProviderRegistry();
  const keyStore = await AnthropicKeyStore.create(context.secrets);
  context.subscriptions.push(
    registry,
    keyStore,
    keyStore.onDidChange(() => registry.notifyChanged()),
  );

  context.subscriptions.push(
    registry.register('copilot', {
      label: 'GitHub Copilot',
      provider: new VsCodeLmProvider(logger),
      isAvailable: () => true,
    }),
    registry.register('anthropic', {
      label: 'Anthropic',
      provider: new AnthropicProvider({
        apiKey: () => keyStore.get(),
        modelOverrides: () =>
          vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown[]>('anthropic.models') ??
          [],
        refusalFallback: () =>
          vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<boolean>('anthropic.refusalFallback') ?? true,
        logger,
      }),
      isAvailable: () => keyStore.hasKey,
    }),
  );

  context.subscriptions.push(
    new ModelStatusBar(registry),
    vscode.commands.registerCommand('aiReview.hello', () => {
      const message = `${PRODUCT_NAME}: Hello! The extension is running.`;
      logger.info('hello command invoked');
      void vscode.window.showInformationMessage(message);
      return message;
    }),
    vscode.commands.registerCommand('aiReview.showLog', () => logger.show()),
    vscode.commands.registerCommand('aiReview.selectModel', (selection?: Partial<Selection>) =>
      selectModelCommand(registry, selection),
    ),
    vscode.commands.registerCommand('aiReview.testConnection', (options?: { silent?: boolean }) =>
      testConnectionCommand(registry, logger, options),
    ),
    vscode.commands.registerCommand('aiReview.setAnthropicApiKey', (key?: unknown) =>
      // Passing the key as an argument is for tests only, so other extensions
      // can't silently swap in their own key.
      setApiKeyCommand(
        keyStore,
        context.extensionMode === vscode.ExtensionMode.Test && typeof key === 'string'
          ? key
          : undefined,
      ),
    ),
    vscode.commands.registerCommand('aiReview.clearAnthropicApiKey', () =>
      clearApiKeyCommand(keyStore),
    ),
  );

  return { registry, keyStore };
}

export function deactivate(): void {}
