import * as vscode from 'vscode';
import { findingRange } from './diagnostics';
import { applyFix, previewFix, type FixOutcome, type FixPreviewProvider } from './fixes';
import type { FindingStatus, FindingStore } from './store';
import type { FindingThreads } from './threads';
import { SUMMARY_URI } from './tree';

export interface FindingCommandDeps {
  store: FindingStore;
  threads: FindingThreads;
  previews: FixPreviewProvider;
}

/**
 * Commands that act on one finding. They accept a finding key (code actions,
 * tree items, tests), a comment thread (thread title buttons) or a tree node.
 */
export function registerFindingCommands(deps: FindingCommandDeps): vscode.Disposable[] {
  const { store, threads, previews } = deps;
  const keyOf = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object') {
      const node = arg as { kind?: string; finding?: { key?: string } };
      if (node.kind === 'finding' && typeof node.finding?.key === 'string') return node.finding.key;
      return threads.keyOf(arg as vscode.CommentThread);
    }
    return undefined;
  };
  const report = (outcome: FixOutcome, silent?: boolean) => {
    if (!outcome.ok && outcome.message && !silent) {
      void vscode.window.showWarningMessage(`AI Review: ${outcome.message}`);
    }
    return outcome;
  };
  const setStatus = (status: FindingStatus) => (arg: unknown) => {
    const key = keyOf(arg);
    if (key) store.setStatus(key, status);
    return !!key;
  };

  return [
    vscode.commands.registerCommand(
      'aiReview.applyFix',
      async (arg: unknown, options?: { silent?: boolean }) => {
        const key = keyOf(arg);
        if (!key) return { ok: false, message: 'Finding not found.' };
        return report(await applyFix(store, key), options?.silent);
      },
    ),
    vscode.commands.registerCommand(
      'aiReview.previewFix',
      async (arg: unknown, options?: { silent?: boolean; accept?: boolean }) => {
        const key = keyOf(arg);
        if (!key) return { ok: false, message: 'Finding not found.' };
        // Tests pass `accept` to answer the question without UI.
        const confirm =
          options?.accept === undefined ? undefined : () => Promise.resolve(options.accept!);
        return report(await previewFix(store, previews, key, confirm), options?.silent);
      },
    ),
    vscode.commands.registerCommand('aiReview.resolveFinding', setStatus('resolved')),
    vscode.commands.registerCommand('aiReview.dismissFinding', setStatus('dismissed')),
    vscode.commands.registerCommand('aiReview.reopenFinding', setStatus('open')),
    vscode.commands.registerCommand('aiReview.revealFinding', async (arg: unknown) => {
      const finding = store.get(keyOf(arg) ?? '');
      if (!finding) return undefined;
      const doc = await vscode.workspace.openTextDocument(finding.uri);
      const range = findingRange(finding, doc);
      const editor = await vscode.window.showTextDocument(doc, {
        selection: range,
        preserveFocus: false,
      });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return editor;
    }),
    vscode.commands.registerCommand('aiReview.showSummary', async () => {
      if (!store.session?.result.summary) {
        void vscode.window.showInformationMessage(
          'AI Review: the last review has no summary. Turn on the aiReview.summary setting to get one.',
        );
        return false;
      }
      await vscode.commands.executeCommand('markdown.showPreview', SUMMARY_URI);
      return true;
    }),
  ];
}
