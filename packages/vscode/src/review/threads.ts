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
 */
export class FindingThreads implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(
    COMMENT_CONTROLLER_ID,
    'AI Review',
  );
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly keys = new Map<vscode.CommentThread, string>();
  private readonly rendered = new Map<string, string>();
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
    return this.threads.get(key);
  }

  private sync(change: StoreChange): void {
    const scope = change.uris ? new Set(change.uris.map(uriKey)) : undefined;
    const wanted = new Map(
      this.store
        .all()
        .filter((f) => f.status !== 'dismissed')
        .filter((f) => !scope || scope.has(uriKey(f.uri)))
        .map((f) => [f.key, f]),
    );
    // Dispose threads of findings that are gone (or dismissed) within the changed scope.
    for (const [key, thread] of this.threads) {
      if (wanted.has(key)) continue;
      const finding = this.store.get(key);
      const inScope = !scope || !finding || scope.has(uriKey(finding.uri));
      if (inScope) this.drop(key, thread);
    }
    for (const finding of wanted.values()) this.render(finding);
  }

  private render(finding: TrackedFinding): void {
    const doc = vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(finding.uri));
    const range = findingRange(finding, doc);
    const signature = JSON.stringify([
      finding.startLine,
      finding.endLine,
      finding.stale,
      finding.status,
      range.end.character,
    ]);
    let thread = this.threads.get(finding.key);
    if (thread && this.rendered.get(finding.key) === signature) return;

    if (!thread) {
      thread = this.controller.createCommentThread(finding.uri, range, []);
      thread.canReply = false;
      this.threads.set(finding.key, thread);
      this.keys.set(thread, finding.key);
    } else {
      thread.range = range;
    }
    this.rendered.set(finding.key, signature);

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

  private drop(key: string, thread: vscode.CommentThread): void {
    thread.dispose();
    this.threads.delete(key);
    this.keys.delete(thread);
    this.rendered.delete(key);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const [key, thread] of this.threads) this.drop(key, thread);
    this.controller.dispose();
  }
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
