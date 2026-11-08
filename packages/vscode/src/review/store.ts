import {
  locateQuote,
  type Finding,
  type ModelInfo,
  type ReviewMode,
  type ReviewResult,
} from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type FindingStatus = 'open' | 'resolved' | 'dismissed';

/** A finding as shown: lines follow the working-tree document as it's edited. */
export interface TrackedFinding extends Finding {
  /** Unique within the store (the fingerprint, plus `#n` if two findings share one). */
  key: string;
  uri: vscode.Uri;
  status: FindingStatus;
}

export interface ReviewSession {
  root: string;
  mode: ReviewMode;
  model: ModelInfo;
  result: ReviewResult;
  finishedAt: Date;
}

export interface StoreChange {
  /** Documents whose findings changed; undefined = everything. */
  uris?: vscode.Uri[];
}

/** Lines kept around a finding when looking for its moved quote. */
const SEARCH_MARGIN = 20;
/** Delay before re-anchoring findings whose code is being edited. */
const REANCHOR_DELAY_MS = 400;

/**
 * Holds the findings of the last review and keeps their ranges on the right code:
 * edits above a finding shift it; edits inside it re-anchor it by quote (debounced,
 * and on save). A finding whose quote is gone is marked stale.
 */
export class FindingStore implements vscode.Disposable {
  private readonly items = new Map<string, TrackedFinding>();
  private readonly emitter = new vscode.EventEmitter<StoreChange>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private current: ReviewSession | undefined;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.reanchorDocument(doc)),
    );
  }

  get session(): ReviewSession | undefined {
    return this.current;
  }

  all(): TrackedFinding[] {
    return [...this.items.values()];
  }

  open(): TrackedFinding[] {
    return this.all().filter((f) => f.status === 'open');
  }

  get(key: string): TrackedFinding | undefined {
    return this.items.get(key);
  }

  forUri(uri: vscode.Uri): TrackedFinding[] {
    const k = uriKey(uri);
    return this.all().filter((f) => uriKey(f.uri) === k);
  }

  /**
   * Replaces the findings with a new review's. Each one is re-anchored by quote
   * against the working-tree document (which may differ from what was reviewed,
   * e.g. for staged changes).
   */
  async set(session: ReviewSession, findings: readonly Finding[]): Promise<TrackedFinding[]> {
    this.cancelPending();
    this.items.clear();
    this.current = session;
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);

    for (const [file, list] of byFile) {
      const uri = vscode.Uri.file(path.join(session.root, ...file.split('/')));
      let lines: string[] | undefined;
      try {
        lines = documentLines(await vscode.workspace.openTextDocument(uri));
      } catch {
        lines = undefined;
      }
      for (const finding of list) {
        let key = finding.id;
        for (let n = 2; this.items.has(key); n++) key = `${finding.id}#${n}`;
        this.items.set(key, { ...reanchor(finding, lines), key, uri, status: 'open' });
      }
    }
    this.emitter.fire({});
    return this.all();
  }

  setStatus(key: string, status: FindingStatus): void {
    const item = this.items.get(key);
    if (!item || item.status === status) return;
    item.status = status;
    // Only open findings are re-anchored while editing; catch up when reopened.
    if (status === 'open' && item.anchor === 'line') {
      const doc = vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(item.uri));
      if (doc) Object.assign(item, placement(reanchor(item, documentLines(doc), true)));
    }
    this.emitter.fire({ uris: [item.uri] });
  }

  /** Marks a finding stale (e.g. its quote is gone when applying a fix). */
  markStale(key: string): void {
    const item = this.items.get(key);
    if (!item || item.stale) return;
    item.stale = true;
    this.emitter.fire({ uris: [item.uri] });
  }

  clear(): void {
    this.cancelPending();
    this.items.clear();
    this.current = undefined;
    this.emitter.fire({});
  }

  /**
   * Re-anchors the document's open findings by their quote, near where they are now.
   * Resolved findings are left alone: applying their fix removes the quote on purpose.
   */
  reanchorDocument(doc: vscode.TextDocument): void {
    this.cancelPending(uriKey(doc.uri));
    const findings = this.forUri(doc.uri).filter((f) => f.anchor === 'line' && f.status === 'open');
    if (!findings.length) return;
    const lines = documentLines(doc);
    let changed = false;
    for (const f of findings) {
      const placed = reanchor(f, lines, true);
      if (
        placed.startLine !== f.startLine ||
        placed.endLine !== f.endLine ||
        placed.stale !== f.stale
      ) {
        Object.assign(f, placement(placed));
        changed = true;
      }
    }
    if (changed) this.emitter.fire({ uris: [doc.uri] });
  }

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (!e.contentChanges.length) return;
    const findings = this.forUri(e.document.uri).filter((f) => f.anchor === 'line');
    if (!findings.length) return;
    let shifted = false;
    let overlapped = false;
    // VS Code sends multi-range edits ordered so each range is valid after the previous one.
    for (const change of e.contentChanges) {
      const from = change.range.start.line + 1;
      const to = change.range.end.line + 1;
      const delta = countNewlines(change.text) - (to - from);
      for (const f of findings) {
        if (to < f.startLine) {
          if (delta) {
            f.startLine += delta;
            f.endLine += delta;
            shifted = true;
          }
        } else if (from <= f.endLine) {
          // The edit touches the finding's own lines: find the quote again shortly.
          overlapped = true;
          if (delta) {
            f.endLine = Math.max(f.startLine, f.endLine + delta);
            shifted = true;
          }
        }
      }
    }
    if (shifted) this.emitter.fire({ uris: [e.document.uri] });
    if (overlapped) this.schedule(e.document);
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = uriKey(doc.uri);
    this.cancelPending(key);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.reanchorDocument(doc);
      }, REANCHOR_DELAY_MS),
    );
  }

  private cancelPending(key?: string): void {
    for (const [k, timer] of this.pending) {
      if (key === undefined || k === key) {
        clearTimeout(timer);
        this.pending.delete(k);
      }
    }
  }

  dispose(): void {
    this.cancelPending();
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.emitter.dispose();
  }
}

export function documentLines(doc: vscode.TextDocument): string[] {
  return Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
}

/** Lines around a finding where its quote is looked for after edits. */
export function searchWindow(finding: Pick<Finding, 'startLine' | 'endLine'>): {
  start: number;
  end: number;
} {
  return { start: finding.startLine - SEARCH_MARGIN, end: finding.endLine + SEARCH_MARGIN };
}

/**
 * Finds the finding's quote in `lines`. `nearby` limits every match to the search
 * window (after edits: the finding's position is tracked, so an identical line far
 * away is a different piece of code). Without it, only the fuzzy step is limited
 * (first placement, when the working tree may differ from what was reviewed).
 */
function reanchor(finding: Finding, lines: string[] | undefined, nearby = false): Finding {
  if (finding.anchor === 'file') return { ...finding, stale: false };
  if (!lines) return { ...finding, stale: true };
  const window = searchWindow(finding);
  const match = locateQuote(lines, finding.quote, {
    nearLine: finding.startLine,
    fuzzyRanges: [window],
    ...(nearby ? { searchRange: window } : {}),
  });
  if (!match) return { ...finding, stale: true };
  return { ...finding, startLine: match.startLine, endLine: match.endLine, stale: false };
}

function placement(f: Finding): Pick<Finding, 'startLine' | 'endLine' | 'stale'> {
  return { startLine: f.startLine, endLine: f.endLine, stale: f.stale };
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Windows paths compare case-insensitively. */
export function uriKey(uri: vscode.Uri): string {
  const s = uri.toString();
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
