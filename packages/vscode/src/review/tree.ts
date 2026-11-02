import {
  DROP_REASON_LABELS,
  SEVERITIES,
  describeMode,
  estimateCostUsd,
  severityRank,
  type Severity,
} from '@ai-review/core';
import * as vscode from 'vscode';
import type { FindingStore, ReviewSession, TrackedFinding } from './store';

export const SUMMARY_SCHEME = 'ai-review-summary';
export const SUMMARY_URI = vscode.Uri.from({ scheme: SUMMARY_SCHEME, path: '/AI Review Summary.md' });

type Node =
  | { kind: 'summary' }
  | { kind: 'file'; file: string; uri: vscode.Uri; findings: TrackedFinding[] }
  | { kind: 'finding'; finding: TrackedFinding }
  | { kind: 'empty' }
  | { kind: 'details' }
  | { kind: 'detail'; label: string; description?: string; tooltip?: string; icon: string };

const ICONS: Record<Severity, [string, string]> = {
  critical: ['error', 'list.errorForeground'],
  major: ['warning', 'list.warningForeground'],
  minor: ['info', 'charts.blue'],
  nit: ['lightbulb', 'descriptionForeground'],
};

/**
 * "AI Review" view in the Source Control sidebar: summary, findings grouped by
 * file (click to go to the code), and review details (model, tokens, cost, drops).
 */
export class FindingsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<Node>;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: FindingStore) {
    this.view = vscode.window.createTreeView('aiReview.findings', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.subscriptions.push(
      this.view,
      store.onDidChange(() => this.refresh()),
    );
  }

  private refresh(): void {
    this.view.description = this.store.session ? countText(this.store.open()) : undefined;
    void vscode.commands.executeCommand('setContext', 'aiReview.hasReview', !!this.store.session);
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const session = this.store.session;
    if (!session) return [];
    if (!node) {
      const roots: Node[] = [];
      if (session.result.summary) roots.push({ kind: 'summary' });
      const files = groupByFile(this.store.open());
      if (files.length) roots.push(...files);
      else roots.push({ kind: 'empty' });
      roots.push({ kind: 'details' });
      return roots;
    }
    if (node.kind === 'file') {
      return node.findings
        .sort((a, b) => a.startLine - b.startLine)
        .map((finding) => ({ kind: 'finding', finding }));
    }
    if (node.kind === 'details') return details(session, this.store.all());
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'summary': {
        const item = new vscode.TreeItem('Summary', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('book');
        item.description = 'walkthrough and top risks';
        item.command = { command: 'aiReview.showSummary', title: 'Show Summary' };
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${node.file.includes('/') ? node.file.slice(0, node.file.lastIndexOf('/')) + ' · ' : ''}${node.findings.length}`;
        item.contextValue = 'file';
        return item;
      }
      case 'finding': {
        const f = node.finding;
        const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
        const [icon, color] = ICONS[f.severity];
        item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        item.description = `${f.anchor === 'file' ? 'file' : `L${f.startLine}`} · ${f.severity}/${f.category}${f.stale ? ' · outdated' : ''}`;
        const tooltip = new vscode.MarkdownString(`**${f.title}**\n\n${f.body}`);
        tooltip.isTrusted = false;
        item.tooltip = tooltip;
        item.contextValue = `finding${f.suggestion !== undefined && !f.stale ? ' fixable' : ''}`;
        item.command = {
          command: 'aiReview.revealFinding',
          title: 'Go to Finding',
          arguments: [f.key],
        };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem('No open findings', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        return item;
      }
      case 'details': {
        const item = new vscode.TreeItem(
          'Review details',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('graph');
        return item;
      }
      case 'detail': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        if (node.description) item.description = node.description;
        if (node.tooltip) item.tooltip = node.tooltip;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.emitter.dispose();
  }
}

function groupByFile(findings: TrackedFinding[]): Node[] {
  const byFile = new Map<string, TrackedFinding[]>();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const worst = (list: TrackedFinding[]) => Math.max(...list.map((f) => severityRank(f.severity)));
  return [...byFile]
    .sort(([a, la], [b, lb]) => worst(lb) - worst(la) || a.localeCompare(b))
    .map(([file, list]) => ({ kind: 'file', file, uri: list[0]!.uri, findings: list }));
}

export function countText(findings: readonly TrackedFinding[]): string {
  if (!findings.length) return 'no open findings';
  return SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
}

function details(session: ReviewSession, all: TrackedFinding[]): Node[] {
  const { result, model } = session;
  const usage = result.usage;
  const out: Node[] = [
    {
      kind: 'detail',
      label: describeMode(session.mode),
      description: session.finishedAt.toLocaleTimeString(),
      icon: 'git-compare',
    },
    { kind: 'detail', label: model.name, description: model.vendor, icon: 'hubot' },
    {
      kind: 'detail',
      label: `${formatTokens(usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))} in · ${formatTokens(usage.outputTokens)} out`,
      description: `${usage.requests} request(s)${usage.estimated ? ' · estimated' : ''}`,
      icon: 'dashboard',
    },
  ];
  if (model.pricing) {
    out.push({
      kind: 'detail',
      label: `≈ $${estimateCostUsd(usage, model.pricing).toFixed(4)}`,
      description: 'cost',
      icon: 'credit-card',
    });
  }
  out.push({
    kind: 'detail',
    label: `${result.reviewedFiles.length} file(s) reviewed`,
    ...(result.skipped.length
      ? {
          description: `${result.skipped.length} skipped`,
          tooltip: result.skipped.map((s) => `${s.path} (${s.reason})`).join('\n'),
        }
      : {}),
    icon: 'files',
  });
  for (const d of result.dropped) {
    out.push({
      kind: 'detail',
      label: `${d.count} dropped`,
      description: DROP_REASON_LABELS[d.reason],
      icon: 'filter',
    });
  }
  const resolved = all.filter((f) => f.status === 'resolved').length;
  const dismissed = all.filter((f) => f.status === 'dismissed').length;
  if (resolved || dismissed) {
    out.push({
      kind: 'detail',
      label: `${resolved} resolved · ${dismissed} dismissed`,
      icon: 'check-all',
    });
  }
  if (result.redactions) {
    out.push({
      kind: 'detail',
      label: `${result.redactions} secret(s) redacted`,
      icon: 'shield',
    });
  }
  for (const e of result.errors) {
    out.push({ kind: 'detail', label: e, icon: 'warning', tooltip: e });
  }
  if (result.cancelled) out.push({ kind: 'detail', label: 'Cancelled (partial results)', icon: 'debug-stop' });
  return out;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Read-only markdown document with the review summary. */
export class SummaryProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: FindingStore) {
    this.subscription = store.onDidChange(() => this.emitter.fire(SUMMARY_URI));
  }

  provideTextDocumentContent(): string {
    const session = this.store.session;
    if (!session?.result.summary) return '# AI Review\n\nNo summary for the last review.\n';
    const open = this.store.open();
    return `# AI Review: ${describeMode(session.mode)}\n\n_${session.model.name} · ${countText(open)}_\n\n${session.result.summary}\n`;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
