import { applyFixToText, computeFix, locateQuote, type FixEdit } from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './diagnostics';
import {
  documentLines,
  searchWindow,
  uriKey,
  type FindingStore,
  type TrackedFinding,
} from './store';

export const PREVIEW_SCHEME = 'ai-review-fix';

export interface FixOutcome {
  ok: boolean;
  message?: string;
}

/**
 * Quick fixes for findings: "Apply fix" (when there's a suggestion and the
 * quoted code is still there), "Preview fix…" and "Dismiss".
 */
export class FindingCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly store: FindingStore) {}

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const first = range.start.line + 1;
    const last = range.end.line + 1;
    for (const f of this.store.forUri(doc.uri)) {
      if (f.status !== 'open' || f.endLine < first || f.startLine > last) continue;
      const diagnostics = context.diagnostics.filter(
        (d) => d.source === DIAGNOSTIC_SOURCE && d.range.start.line === f.startLine - 1,
      );
      if (f.suggestion !== undefined && !f.stale) {
        const apply = new vscode.CodeAction(
          `AI Review: Apply fix — ${f.title}`,
          vscode.CodeActionKind.QuickFix,
        );
        apply.command = { command: 'aiReview.applyFix', title: 'Apply Fix', arguments: [f.key] };
        apply.diagnostics = diagnostics;
        apply.isPreferred = f.severity === 'critical' || f.severity === 'major';
        actions.push(apply);
        const preview = new vscode.CodeAction(
          `AI Review: Preview fix… — ${f.title}`,
          vscode.CodeActionKind.QuickFix,
        );
        preview.command = {
          command: 'aiReview.previewFix',
          title: 'Preview Fix',
          arguments: [f.key],
        };
        preview.diagnostics = diagnostics;
        actions.push(preview);
      }
      const dismiss = new vscode.CodeAction(
        `AI Review: Dismiss — ${f.title}`,
        vscode.CodeActionKind.QuickFix,
      );
      dismiss.command = {
        command: 'aiReview.dismissFinding',
        title: 'Dismiss',
        arguments: [f.key],
      };
      dismiss.diagnostics = diagnostics;
      actions.push(dismiss);
    }
    return actions;
  }
}

/** Serves the proposed file content for the fix preview diff. */
export class FixPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

type Planned =
  | { ok: true; finding: TrackedFinding; doc: vscode.TextDocument; edit: FixEdit }
  | { ok: false; message: string };

/** Re-anchors the finding in the current document and computes its edit. */
async function plan(store: FindingStore, key: string): Promise<Planned> {
  const finding = store.get(key);
  if (!finding || finding.status !== 'open') return { ok: false, message: 'Finding not found.' };
  if (finding.suggestion === undefined) {
    return { ok: false, message: 'This finding has no suggested fix.' };
  }
  const doc = await vscode.workspace.openTextDocument(finding.uri);
  const lines = documentLines(doc);
  // Only near the finding: an identical line elsewhere is different code.
  const searchRange = searchWindow(finding);
  const edit = computeFix(lines, finding, { searchRange });
  if (!edit) {
    const stillThere = locateQuote(lines, finding.quote, {
      nearLine: finding.startLine,
      searchRange,
    });
    if (!stillThere) store.markStale(key);
    return {
      ok: false,
      message: stillThere
        ? 'The code changed since the review, so the fix can’t be applied automatically.'
        : 'The code this finding refers to is gone; the fix can’t be applied.',
    };
  }
  return { ok: true, finding, doc, edit };
}

/** Applies a finding's suggestion as one undoable edit and marks the finding resolved. */
export async function applyFix(store: FindingStore, key: string): Promise<FixOutcome> {
  const planned = await plan(store, key);
  if (!planned.ok) return planned;
  const { doc, edit, finding } = planned;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.replace(
    doc.uri,
    new vscode.Range(edit.startLine - 1, edit.startColumn, edit.endLine - 1, edit.endColumn),
    edit.newText.replace(/\n/g, eol),
  );
  // Resolve first: the store only re-anchors open findings, so the edit removing
  // the quote doesn't mark this one outdated.
  store.setStatus(key, 'resolved');
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  if (!applied) {
    store.setStatus(key, 'open');
    return { ok: false, message: `Could not edit ${path.basename(finding.file)}.` };
  }
  return { ok: true };
}

/**
 * Shows the fix as a diff (current file ↔ file with the fix), then asks whether
 * to apply it. `confirm` replaces the question (tests).
 */
export async function previewFix(
  store: FindingStore,
  previews: FixPreviewProvider,
  key: string,
  confirm?: () => Thenable<boolean>,
): Promise<FixOutcome & { applied?: boolean }> {
  const planned = await plan(store, key);
  if (!planned.ok) return planned;
  const { doc, edit, finding } = planned;
  const previewUri = vscode.Uri.from({
    scheme: PREVIEW_SCHEME,
    path: `/${finding.file}`,
    query: `key=${encodeURIComponent(key)}`,
  });
  previews.set(previewUri, applyFixToText(doc.getText(), edit));
  await vscode.commands.executeCommand(
    'vscode.diff',
    doc.uri,
    previewUri,
    `${path.basename(finding.file)} ↔ AI fix: ${finding.title}`,
    { preview: true },
  );

  const ask =
    confirm ??
    (() =>
      vscode.window
        .showInformationMessage(`AI Review: apply the fix for "${finding.title}"?`, 'Apply Fix')
        .then((choice) => choice === 'Apply Fix'));
  const yes = await ask();
  await closePreview(previewUri);
  previews.delete(previewUri);
  if (!yes) return { ok: true, applied: false };
  const result = await applyFix(store, key);
  if (result.ok) await vscode.window.showTextDocument(doc, { preview: false });
  return { ...result, applied: result.ok };
}

async function closePreview(previewUri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputTextDiff &&
        uriKey(t.input.modified) === uriKey(previewUri),
    );
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}
