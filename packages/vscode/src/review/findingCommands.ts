import { findingChatPrompt, reviewChatPrompt, reviewToMarkdown } from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentChat } from './chat';
import { findingRange } from './diagnostics';
import { newReportUri, sessionReport } from './export';
import { applyFix, previewFix, type FixOutcome, type FixPreviewProvider } from './fixes';
import type { FindingStatus, FindingStore, ReviewSession } from './store';
import type { FindingThreads } from './threads';
import { SUMMARY_URI } from './tree';

export interface FindingCommandDeps {
  store: FindingStore;
  threads: FindingThreads;
  previews: FixPreviewProvider;
  chat: AgentChat;
}

/**
 * Commands that act on one finding. They accept a finding key (code actions,
 * tree items, tests), a comment thread (thread title buttons) or a tree node.
 * Keys are new with every review: a key from an earlier one (e.g. a quick fix menu
 * opened before it) finds nothing.
 */
export function registerFindingCommands(deps: FindingCommandDeps): vscode.Disposable[] {
  const { store, threads, previews, chat } = deps;
  const savedReports = new WeakMap<ReviewSession, vscode.Uri>();
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
    vscode.commands.registerCommand('aiReview.saveReview', async () => {
      const session = store.session;
      const report = sessionReport(store);
      if (!session || !report) {
        void vscode.window.showInformationMessage('AI Review: there is no review to save yet.');
        return undefined;
      }
      // Saving the same review again updates its file.
      const uri = savedReports.get(session) ?? (await newReportUri(session));
      savedReports.set(session, uri);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(reviewToMarkdown(report), 'utf8'));
      await vscode.window.showTextDocument(uri, { preview: false });
      return uri;
    }),
    vscode.commands.registerCommand('aiReview.sendReviewToChat', async () => {
      const session = store.session;
      const report = sessionReport(store);
      if (!session || !report) {
        void vscode.window.showInformationMessage('AI Review: there is no review to send yet.');
        return false;
      }
      // Named as the chat sees the workspace (with the folder in a multi-root one).
      const filePath = (file: string) =>
        vscode.workspace.asRelativePath(
          vscode.Uri.file(path.join(session.root, ...file.split('/'))),
        );
      return chat.send(reviewChatPrompt(report, { filePath }));
    }),
    vscode.commands.registerCommand('aiReview.sendFindingToChat', async (arg: unknown) => {
      const finding = store.get(keyOf(arg) ?? '');
      if (!finding) return false;
      return chat.send(
        findingChatPrompt(finding, { file: vscode.workspace.asRelativePath(finding.uri) }),
      );
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
