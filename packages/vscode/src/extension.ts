import { AnthropicProvider, PRODUCT_NAME } from '@ai-review/core';
import * as vscode from 'vscode';
import { testConnectionCommand } from './commands/testConnection';
import { OutputChannelLogger } from './logger';
import { AnthropicKeyStore, clearApiKeyCommand, setApiKeyCommand } from './providers/apiKey';
import { VsCodeLmProvider } from './providers/copilot';
import { ModelStatusBar, selectModelCommand } from './providers/picker';
import { CONFIG_SECTION, ProviderRegistry, type Selection } from './providers/registry';
import {
  cancelReview,
  reviewCommand,
  type ReviewCommandArgs,
  type ReviewKind,
} from './review/commands';
import { ReviewConfigService } from './review/config';
import { FindingsDiagnostics } from './review/diagnostics';
import { registerFindingCommands } from './review/findingCommands';
import { FindingCodeActions, FixPreviewProvider, PREVIEW_SCHEME } from './review/fixes';
import { RepoLocator } from './review/repo';
import { SnapshotStore } from './review/snapshots';
import { FindingStatusStore } from './review/state';
import { FindingStore } from './review/store';
import { FindingThreads } from './review/threads';
import { FindingsTree, SUMMARY_SCHEME, SummaryProvider } from './review/tree';
import { ReviewPanel } from './ui/panel';

/** Returned from `activate`; used by extension tests. Not a stable public API. */
export interface ExtensionApi {
  registry: ProviderRegistry;
  keyStore: AnthropicKeyStore;
  repos: RepoLocator;
  configs: ReviewConfigService;
  findings: FindingStore;
  statuses: FindingStatusStore;
  snapshots: SnapshotStore;
  threads: FindingThreads;
  tree: FindingsTree;
  panel: ReviewPanel;
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
  const statuses = new FindingStatusStore(context.workspaceState);
  const snapshots = new SnapshotStore(context.workspaceState);
  const store = new FindingStore(statuses);
  const threads = new FindingThreads(store);
  const tree = new FindingsTree(store);
  const previews = new FixPreviewProvider();
  const summaries = new SummaryProvider(store);
  context.subscriptions.push(
    configs,
    store,
    new FindingsDiagnostics(store),
    threads,
    tree,
    previews,
    summaries,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),
    vscode.workspace.registerTextDocumentContentProvider(SUMMARY_SCHEME, summaries),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new FindingCodeActions(store),
      {
        providedCodeActionKinds: FindingCodeActions.kinds,
      },
    ),
    ...registerFindingCommands({ store, threads, previews }),
  );
  const deps = { registry, repos, configs, store, logger, snapshots };
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
  const panel = new ReviewPanel(context, { registry, repos, store, logger });
  context.subscriptions.push(
    panel,
    vscode.commands.registerCommand('aiReview.clearFindings', async () => {
      store.clear();
      // A fresh start: the next review sends everything again.
      await snapshots.clear();
    }),
    vscode.commands.registerCommand(
      'aiReview.forgetFindingStatus',
      async (options?: { silent?: boolean }) => {
        const n = await statuses.clear();
        if (!options?.silent) {
          void vscode.window.showInformationMessage(
            `AI Review: forgot ${n} dismissed or resolved finding(s). They will show again in the next review.`,
          );
        }
        return n;
      },
    ),
    vscode.commands.registerCommand('aiReview.runReview', (arg?: unknown) =>
      panel.run(isArgs(arg) ? arg : {}),
    ),
    vscode.commands.registerCommand('aiReview.cancelReview', () => cancelReview()),
    vscode.commands.registerCommand('aiReview.openPanel', () =>
      vscode.commands.executeCommand('workbench.view.extension.aiReview'),
    ),
  );

  return {
    registry,
    keyStore,
    repos,
    configs,
    findings: store,
    statuses,
    snapshots,
    threads,
    tree,
    panel,
  };
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
    ['root', 'path', 'startLine', 'endLine', 'base', 'silent', 'confirmCost'].some((k) => k in arg)
  );
}
