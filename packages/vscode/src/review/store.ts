import {
  locateQuote,
  type Finding,
  type ModelInfo,
  type ReviewMode,
  type ReviewResult,
} from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewRuns } from './runs';
import type { FindingStatusStore } from './state';

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
  /** The run that produced it (`ReviewRun.generation`); one session per run. */
  generation: number;
}

export interface StoreChange {
  /** Documents whose findings changed; undefined = everything. */
  uris?: vscode.Uri[];
  /** A new review's findings replaced the old ones, or they were cleared. */
  newSession?: boolean;
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
  private items = new Map<string, TrackedFinding>();
  private readonly emitter = new vscode.EventEmitter<StoreChange>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private current: ReviewSession | undefined;
  /** Counts `set` and `clear` calls; only the latest one may write. */
  private writes = 0;

  readonly onDidChange = this.emitter.event;

  /**
   * Only the current run's sessions are accepted (see `set`). `statuses` persists
   * dismissed/resolved findings across reviews and reloads.
   */
  constructor(
    private readonly runs: ReviewRuns,
    private readonly statuses?: FindingStatusStore,
  ) {
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
   * e.g. for staged changes). The documents are opened first and the findings
   * swapped in at once, so overlapping calls never mix: a call that a newer `set`
   * or `clear` overtook changes nothing and returns undefined, and so does a
   * session from a run that a newer run superseded.
   */
  async set(
    session: ReviewSession,
    findings: readonly Finding[],
  ): Promise<TrackedFinding[] | undefined> {
    const write = ++this.writes;
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    const docs = new Map<string, vscode.TextDocument | undefined>();
    for (const file of byFile.keys()) {
      try {
        docs.set(file, await vscode.workspace.openTextDocument(fileUri(session.root, file)));
      } catch {
        docs.set(file, undefined);
      }
    }
    if (write !== this.writes || session.generation < this.runs.generation) return undefined;

    const items = new Map<string, TrackedFinding>();
    for (const [file, list] of byFile) {
      const uri = fileUri(session.root, file);
      const doc = docs.get(file);
      // Read now, not when opened: the document may have been edited meanwhile.
      const lines = doc ? documentLines(doc) : undefined;
      for (const finding of list) {
        let key = finding.id;
        for (let n = 2; items.has(key); n++) key = `${finding.id}#${n}`;
        // A finding the user dismissed or resolved before keeps that status.
        const status = this.statuses?.lookup(session.root, finding) ?? 'open';
        items.set(key, { ...reanchor(finding, lines), key, uri, status });
      }
    }
    this.cancelPending();
    this.items = items;
    this.current = session;
    this.emitter.fire({ newSession: true });
    return this.all();
  }

  setStatus(key: string, status: FindingStatus): void {
    const item = this.items.get(key);
    if (!item || item.status === status) return;
    item.status = status;
    if (this.current) void this.statuses?.set(this.current.root, item, status);
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
    this.writes++;
    this.cancelPending();
    this.items = new Map();
    this.current = undefined;
    this.emitter.fire({ newSession: true });
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
      // A range ending at column 0 of a line leaves that line's text alone (whole lines
      // deleted or inserted right above it), so it counts as above that line.
      const end = change.range.end.character === 0 ? to - 1 : to;
      for (const f of findings) {
        if (end < f.startLine) {
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

function fileUri(root: string, file: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, ...file.split('/')));
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
