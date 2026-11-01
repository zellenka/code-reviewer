import { locateQuote, type Finding, type Severity } from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  major: vscode.DiagnosticSeverity.Warning,
  minor: vscode.DiagnosticSeverity.Information,
  nit: vscode.DiagnosticSeverity.Hint,
};

/** Shows findings in the Problems panel. Lines are converted from 1-based here only. */
export class FindingsDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('aiReview');
  private current: Finding[] = [];

  get findings(): readonly Finding[] {
    return this.current;
  }

  /**
   * Replaces all diagnostics. Each finding is re-anchored by quote against the
   * working-tree document (which may differ from what was reviewed, e.g. for staged);
   * when the quote isn't there any more it's marked stale.
   */
  async show(root: string, findings: Finding[]): Promise<Finding[]> {
    this.collection.clear();
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);

    const shown: Finding[] = [];
    for (const [file, list] of byFile) {
      const uri = vscode.Uri.file(path.join(root, ...file.split('/')));
      let lines: string[] | undefined;
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
      } catch {
        lines = undefined;
      }
      const diagnostics: vscode.Diagnostic[] = [];
      for (const finding of list) {
        const placed = reanchor(finding, lines);
        shown.push(placed);
        diagnostics.push(toDiagnostic(placed, lines));
      }
      this.collection.set(uri, diagnostics);
    }
    this.current = shown;
    return shown;
  }

  clear(): void {
    this.collection.clear();
    this.current = [];
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function reanchor(finding: Finding, lines: string[] | undefined): Finding {
  if (finding.anchor === 'file') return { ...finding, stale: false };
  if (!lines) return { ...finding, stale: true };
  const match = locateQuote(lines, finding.quote, {
    nearLine: finding.startLine,
    fuzzyRanges: [{ start: finding.startLine - 20, end: finding.endLine + 20 }],
  });
  if (!match) return { ...finding, stale: true };
  return { ...finding, startLine: match.startLine, endLine: match.endLine, stale: false };
}

function toDiagnostic(finding: Finding, lines: string[] | undefined): vscode.Diagnostic {
  const start = Math.max(0, finding.startLine - 1);
  const end = Math.max(start, finding.endLine - 1);
  const endChar = lines?.[end]?.length ?? Number.MAX_SAFE_INTEGER;
  const firstIndent = lines?.[start]?.search(/\S/) ?? 0;
  const range = new vscode.Range(start, Math.max(0, firstIndent), end, endChar);
  const message = `${finding.stale ? '(outdated) ' : ''}${finding.title}\n\n${finding.body}`;
  const diagnostic = new vscode.Diagnostic(range, message, SEVERITY[finding.severity]);
  diagnostic.source = 'AI Review';
  diagnostic.code = `${finding.severity}/${finding.category}`;
  if (finding.stale) diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
  return diagnostic;
}
