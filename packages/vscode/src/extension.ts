import { AnthropicProvider, PRODUCT_NAME } from '@ai-review/core';
import * as vscode from 'vscode';
import { testConnectionCommand } from './commands/testConnection';
import { OutputChannelLogger } from './logger';
import { AnthropicKeyStore, clearApiKeyCommand, setApiKeyCommand } from './providers/apiKey';
import { VsCodeLmProvider } from './providers/copilot';
import { ModelStatusBar, selectModelCommand } from './providers/picker';
import { CONFIG_SECTION, ProviderRegistry, type Selection } from './providers/registry';
import { reviewCommand, type ReviewCommandArgs, type ReviewKind } from './review/commands';
import { ReviewConfigService } from './review/config';
import { FindingsDiagnostics } from './review/diagnostics';
import { RepoLocator } from './review/repo';

/** Returned from `activate`; used by extension tests. Not a stable public API. */
export interface ExtensionApi {
  registry: ProviderRegistry;
  keyStore: AnthropicKeyStore;
  repos: RepoLocator;
  configs: ReviewConfigService;
  diagnostics: FindingsDiagnostics;
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

  const repos = new RepoLocator(logger);
  const configs = new ReviewConfigService(logger);
  const diagnostics = new FindingsDiagnostics();
  context.subscriptions.push(configs, diagnostics);
  const deps = { registry, repos, configs, diagnostics, logger };
  const reviewCommands: [string, ReviewKind][] = [
    ['aiReview.reviewStaged', 'staged'],
    ['aiReview.reviewUnstaged', 'unstaged'],
    ['aiReview.reviewBranch', 'branch'],
    ['aiReview.reviewFile', 'file'],
    ['aiReview.reviewSelection', 'selection'],
  ];
  for (const [id, kind] of reviewCommands) {
    context.subscriptions.push(
      // Menus pass a Uri (explorer) or an SCM object; commands from tests pass options.
      vscode.commands.registerCommand(id, (arg?: unknown) =>
        reviewCommand(
          kind,
          deps,
          isArgs(arg) ? arg : scmRoot(arg) ? { root: scmRoot(arg)! } : {},
          arg instanceof vscode.Uri ? arg : undefined,
        ),
      ),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('aiReview.clearFindings', () => diagnostics.clear()),
  );

  return { registry, keyStore, repos, configs, diagnostics };
}

export function deactivate(): void {}

/** The SCM title menu passes the clicked repository's SourceControl. */
function scmRoot(arg: unknown): string | undefined {
  const uri = (arg as { rootUri?: unknown } | undefined)?.rootUri;
  return uri instanceof vscode.Uri ? uri.fsPath : undefined;
}

function isArgs(arg: unknown): arg is ReviewCommandArgs {
  return (
    !!arg &&
    typeof arg === 'object' &&
    !(arg instanceof vscode.Uri) &&
    ['root', 'path', 'startLine', 'endLine', 'base', 'silent'].some((k) => k in arg)
  );
}
