import { neutralizeMarkdown, type Severity } from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findingRange } from './diagnostics';
import { uriKey, type FindingStore, type StoreChange, type TrackedFinding } from './store';

export const COMMENT_CONTROLLER_ID = 'aiReview';

const BADGE: Record<Severity, string> = {
  critical: '🔴 Critical',
  major: '🟠 Major',
  minor: '🔵 Minor',
  nit: '⚪ Nit',
};

/**
 * Inline comment threads, one per finding (CodeRabbit-style). Read-only: actions
 * (apply/preview fix, resolve, dismiss, reopen) are thread title buttons whose
 * visibility depends on the thread's contextValue words: `open`/`resolved`, `fixable`.
 * Threads are kept by file and fingerprint, not by finding key (new with every review):
 * a re-review that reports a finding again updates its thread in place.
 */
export class FindingThreads implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(
    COMMENT_CONTROLLER_ID,
    'AI Review',
  );
  /** By slot (see `slotsOf`). */
  private readonly threads = new Map<string, vscode.CommentThread>();
  /** The key of the finding each thread shows now. */
  private readonly keys = new Map<vscode.CommentThread, string>();
  /** By slot. */
  private readonly rendered = new Map<string, string>();
  /** Finding key → slot, for the store's current findings. */
  private slots = new Map<string, string>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: FindingStore) {
    this.controller.options = { placeHolder: '', prompt: '' };
    this.subscription = store.onDidChange((change) => this.sync(change));
  }

  /** Finding key for a thread passed to a menu command. */
  keyOf(thread: vscode.CommentThread): string | undefined {
    return this.keys.get(thread);
  }

  threadOf(key: string): vscode.CommentThread | undefined {
    const slot = this.slots.get(key);
    return slot === undefined ? undefined : this.threads.get(slot);
  }

  private sync(change: StoreChange): void {
    this.slots = slotsOf(this.store.all());
    const scope = change.uris ? new Set(change.uris.map(uriKey)) : undefined;
    const wanted = new Map(
      this.store
        .all()
        .filter((f) => f.status !== 'dismissed')
        .filter((f) => !scope || scope.has(uriKey(f.uri)))
        .map((f) => [this.slots.get(f.key)!, f]),
    );
    // Dispose threads of findings that are gone (or dismissed) within the changed scope.
    for (const [slot, thread] of this.threads) {
      if (wanted.has(slot)) continue;
      if (!scope || scope.has(uriKey(thread.uri))) this.drop(slot, thread);
    }
    for (const [slot, finding] of wanted) this.render(slot, finding);
  }

  private render(slot: string, finding: TrackedFinding): void {
    const doc = vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(finding.uri));
    const range = findingRange(finding, doc);
    // The text counts too: a re-review can report the same finding (file and fingerprint)
    // with new wording or a new suggestion, and "Apply fix" uses the store's.
    const signature = JSON.stringify([
      finding.startLine,
      finding.endLine,
      finding.stale,
      finding.status,
      range.end.character,
      finding.severity,
      finding.category,
      finding.confidence,
      finding.title,
      finding.body,
      finding.suggestion,
    ]);
    let thread = this.threads.get(slot);
    if (thread) {
      // Its buttons act on the finding it shows now, from the latest review.
      this.keys.set(thread, finding.key);
      if (this.rendered.get(slot) === signature) return;
      thread.range = range;
    } else {
      thread = this.controller.createCommentThread(finding.uri, range, []);
      thread.canReply = false;
      this.threads.set(slot, thread);
      this.keys.set(thread, finding.key);
    }
    this.rendered.set(slot, signature);

    const fixable = finding.status === 'open' && !!finding.suggestion && !finding.stale;
    thread.contextValue = [finding.status, fixable ? 'fixable' : undefined]
      .filter(Boolean)
      .join(' ');
    thread.label = `AI Review · ${finding.severity}${finding.stale ? ' · outdated' : ''}${finding.status === 'resolved' ? ' · resolved' : ''}`;
    thread.state =
      finding.status === 'resolved'
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    thread.collapsibleState =
      finding.status === 'open' && !finding.stale
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;
    thread.comments = [
      {
        author: { name: 'AI Review' },
        body: commentBody(finding),
        mode: vscode.CommentMode.Preview,
        label: `${finding.category} · ${Math.round(finding.confidence * 100)}% confidence`,
        contextValue: thread.contextValue,
      },
    ];
  }

  private drop(slot: string, thread: vscode.CommentThread): void {
    thread.dispose();
    this.threads.delete(slot);
    this.keys.delete(thread);
    this.rendered.delete(slot);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const [slot, thread] of this.threads) this.drop(slot, thread);
    this.controller.dispose();
  }
}

/**
 * Where each finding's thread is kept: its file (a thread can't move to another file,
 * e.g. in another repository) and fingerprint, numbered when findings share both
 * (two secrets that look the same once redacted).
 */
function slotsOf(findings: readonly TrackedFinding[]): Map<string, string> {
  const slots = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const f of findings) {
    const base = `${uriKey(f.uri)}\n${f.id}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    slots.set(f.key, `${base}\n${n}`);
  }
  return slots;
}

export function commentBody(finding: TrackedFinding): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = false;
  md.isTrusted = false;
  md.appendMarkdown(`**${BADGE[finding.severity]}** · **${escape(finding.title)}**\n\n`);
  if (finding.stale) {
    md.appendMarkdown('_Outdated: the code this comment refers to has changed._\n\n');
  }
  md.appendMarkdown(`${neutralizeMarkdown(finding.body)}\n\n`);
  if (finding.suggestion !== undefined) {
    md.appendMarkdown('**Suggested change:**\n');
    md.appendCodeblock(finding.suggestion, languageOf(finding.file));
  }
  return md;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.swift': 'swift',
  '.sh': 'shellscript',
  '.sql': 'sql',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

function languageOf(file: string): string {
  return LANGUAGES[path.extname(file).toLowerCase()] ?? '';
}
