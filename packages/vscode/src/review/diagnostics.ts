import type { Severity } from '@ai-review/core';
import * as vscode from 'vscode';
import { uriKey, type FindingStore, type StoreChange, type TrackedFinding } from './store';

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  major: vscode.DiagnosticSeverity.Warning,
  minor: vscode.DiagnosticSeverity.Information,
  nit: vscode.DiagnosticSeverity.Hint,
};

export const DIAGNOSTIC_SOURCE = 'AI Review';

/** Shows open findings in the Problems panel. Lines are converted from 1-based here only. */
export class FindingsDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('aiReview');
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: FindingStore) {
    this.subscription = store.onDidChange((change) => this.render(change));
  }

  private render(change: StoreChange): void {
    if (!change.uris) {
      this.collection.clear();
      const byUri = new Map<string, TrackedFinding[]>();
      for (const f of this.store.open()) {
        byUri.set(uriKey(f.uri), [...(byUri.get(uriKey(f.uri)) ?? []), f]);
      }
      for (const list of byUri.values()) this.renderUri(list[0]!.uri);
      return;
    }
    for (const uri of change.uris) this.renderUri(uri);
  }

  private renderUri(uri: vscode.Uri): void {
    const findings = this.store.forUri(uri).filter((f) => f.status === 'open');
    if (!findings.length) {
      this.collection.delete(uri);
      return;
    }
    const doc = vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(uri));
    this.collection.set(
      uri,
      findings.map((f) => toDiagnostic(f, doc)),
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }
}

/** The editor range of a finding: from the first non-blank character to the end of its last line. */
export function findingRange(
  finding: Pick<TrackedFinding, 'startLine' | 'endLine'>,
  doc: vscode.TextDocument | undefined,
): vscode.Range {
  const last = doc ? doc.lineCount - 1 : Number.MAX_SAFE_INTEGER;
  const start = Math.min(Math.max(0, finding.startLine - 1), last);
  const end = Math.min(Math.max(start, finding.endLine - 1), last);
  if (!doc) return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
  const first = doc.lineAt(start);
  return new vscode.Range(
    start,
    first.firstNonWhitespaceCharacterIndex,
    end,
    doc.lineAt(end).text.length,
  );
}

function toDiagnostic(finding: TrackedFinding, doc: vscode.TextDocument | undefined) {
  const message = `${finding.stale ? '(outdated) ' : ''}${finding.title}\n\n${finding.body}`;
  const diagnostic = new vscode.Diagnostic(
    findingRange(finding, doc),
    message,
    SEVERITY[finding.severity],
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = `${finding.severity}/${finding.category}`;
  return diagnostic;
}
