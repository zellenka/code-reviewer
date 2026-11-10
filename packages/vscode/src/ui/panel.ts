import { isSafeRef } from '@ai-review/node-host';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '@ai-review/core';
import { CONFIG_SECTION, targetFor, type ProviderRegistry } from '../providers/registry';
import {
  cancelReview,
  isReviewRunning,
  onDidChangeReviewRunning,
  summarize,
  type ReviewCommandArgs,
  type ReviewCommandResult,
} from '../review/commands';
import { relativeToRepo, type RepoLocator } from '../review/repo';
import type { FindingStore } from '../review/store';
import { panelHtml } from './panelHtml';

export const SCOPES = ['unstaged', 'staged', 'branch', 'file', 'selection'] as const;
export type PanelScope = (typeof SCOPES)[number];

const REVIEW_COMMANDS: Record<PanelScope, string> = {
  unstaged: 'aiReview.reviewUnstaged',
  staged: 'aiReview.reviewStaged',
  branch: 'aiReview.reviewBranch',
  file: 'aiReview.reviewFile',
  selection: 'aiReview.reviewSelection',
};

const REVIEW_MODES = ['auto', 'single-pass', 'agentic'] as const;

/** Commands the panel's buttons may run. Anything else from the webview is ignored. */
const PANEL_COMMANDS = new Set([
  'aiReview.selectModel',
  'aiReview.setAnthropicApiKey',
  'aiReview.testConnection',
  'aiReview.showSummary',
  'aiReview.clearFindings',
  'aiReview.showLog',
  'aiReview.findings.focus',
]);

/** What the user picked in the panel; remembered per workspace. */
export interface PanelChoices {
  scope: PanelScope;
  /** Repository root (absolute). Undefined = the active editor's repo, or ask. */
  root?: string;
  /** Base for branch reviews. Undefined = `aiReview.baseBranch`, then origin/HEAD, main, master. */
  base?: string;
}

/** Everything the webview renders. Sent on every change. */
export interface PanelState {
  scope: PanelScope;
  roots: { root: string; label: string }[];
  root: string;
  base: string;
  basePlaceholder: string;
  branches: string[];
  file?: string;
  selection?: string;
  model: { label: string; ok: boolean; detail?: string; needsKey: boolean };
  reviewMode: string;
  includeContext: boolean;
  running: boolean;
  last?: { text: string; level: 'info' | 'warn' | 'error'; hasSummary: boolean; open: number };
}

const STATE_KEY = 'aiReview.panel';
const ROOTS_TTL_MS = 5_000;

/**
 * "Review" view in the AI Review sidebar: pick what to review (scope, repository,
 * base branch), how (model, mode, context) and run or cancel the review.
 */
export class ReviewPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'aiReview.controls';

  private view?: vscode.WebviewView;
  private lastError?: { text: string; level: 'warn' | 'error' };
  private readonly branchCache = new Map<string, string[]>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  /** Bumped per refresh; a slower, older snapshot must not overwrite a newer one. */
  private refreshSeq = 0;
  /** Cached between refreshes; selection changes refresh often and shouldn't hit git or the model list. */
  private rootsCache?: { at: number; roots: Promise<string[]> };
  private modelCache?: Promise<PanelState['model']>;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: {
      registry: ProviderRegistry;
      repos: RepoLocator;
      store: FindingStore;
      logger: Logger;
    },
  ) {
    const refresh = () => this.scheduleRefresh();
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ReviewPanel.viewId, this),
      deps.registry.onDidChange(() => {
        this.modelCache = undefined;
        refresh();
      }),
      deps.store.onDidChange(() => {
        // A newer review (from any command) replaces the panel's last error.
        this.lastError = undefined;
        refresh();
      }),
      onDidChangeReviewRunning(refresh),
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.window.onDidChangeTextEditorSelection(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rootsCache = undefined;
        refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) refresh();
      }),
    );
  }

  get choices(): PanelChoices {
    const saved = this.context.workspaceState.get<Partial<PanelChoices>>(STATE_KEY) ?? {};
    return {
      scope: SCOPES.includes(saved.scope as PanelScope) ? saved.scope! : 'unstaged',
      ...(saved.root ? { root: saved.root } : {}),
      ...(saved.base ? { base: saved.base } : {}),
    };
  }

  /** Changes the remembered choices. Empty strings clear `root`/`base`. */
  async update(changes: Partial<PanelChoices>): Promise<void> {
    const next: PanelChoices = { ...this.choices, ...changes };
    if (!next.root) delete next.root;
    if (!next.base) delete next.base;
    await this.context.workspaceState.update(STATE_KEY, next);
    this.scheduleRefresh();
  }

  /** Runs a review with the panel's choices ("AI Review: Run Review"). */
  async run(extra: ReviewCommandArgs = {}): Promise<ReviewCommandResult | undefined> {
    const { scope, root, base } = this.choices;
    const args: ReviewCommandArgs = { ...extra };
    // File and selection reviews find the repo from the file itself.
    if (root && scope !== 'file' && scope !== 'selection') {
      if ((await this.roots()).includes(root)) args.root = root;
    }
    if (scope === 'branch' && base) args.base = base;
    this.lastError = undefined;
    const result = await vscode.commands.executeCommand<ReviewCommandResult | undefined>(
      REVIEW_COMMANDS[scope],
      args,
    );
    if (result && !result.ok && result.message && result.message !== 'cancelled') {
      this.lastError = { text: result.message, level: 'warn' };
    }
    this.scheduleRefresh();
    return result;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [],
    };
    view.webview.html = panelHtml(view.webview.cspSource, nonce());
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.clearCaches();
        this.scheduleRefresh();
      }
    });
    view.webview.onDidReceiveMessage((msg: unknown) => {
      void this.handle(msg).catch((err) =>
        this.deps.logger.error(err instanceof Error ? err : String(err)),
      );
    });
  }

  /** Current panel state (also used by tests). */
  async snapshot(): Promise<PanelState> {
    const { scope, root, base } = this.choices;
    const roots = await this.roots();
    const activeRoot = root && roots.includes(root) ? root : '';
    const branchRoot = activeRoot || (roots.length === 1 ? roots[0]! : '');
    const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const configuredBase = settings.get<string>('baseBranch');

    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document.uri.scheme === 'file' ? editor.document : undefined;
    const file = doc ? vscode.workspace.asRelativePath(doc.uri, roots.length > 1) : undefined;
    let selection: string | undefined;
    if (doc && editor && !editor.selection.isEmpty) {
      const sel = editor.selection;
      const end =
        sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      selection = `${file} · lines ${sel.start.line + 1}–${end}`;
    }

    const session = this.deps.store.session;
    let last: PanelState['last'];
    if (this.lastError) last = { ...this.lastError, hasSummary: false, open: 0 };
    else if (session) {
      last = {
        text: summarize(session.result, session.model),
        level: session.result.errors.length && !session.result.findings.length ? 'warn' : 'info',
        hasSummary: !!session.result.summary,
        open: this.deps.store.open().length,
      };
    }

    return {
      scope,
      roots: roots.map((r) => ({ root: r, label: label(r, roots) })),
      root: activeRoot,
      base: base ?? '',
      basePlaceholder: configuredBase || 'auto (origin/HEAD, main or master)',
      branches: branchRoot ? await this.branches(branchRoot) : [],
      ...(file ? { file } : {}),
      ...(selection ? { selection } : {}),
      model: await (this.modelCache ??= this.model()),
      reviewMode: settings.get<string>('reviewMode') ?? 'auto',
      includeContext: settings.get<boolean>('includeContext') ?? true,
      running: isReviewRunning(),
      ...(last ? { last } : {}),
    };
  }

  private async model(): Promise<PanelState['model']> {
    const { registry } = this.deps;
    const { providerId } = registry.getSelection();
    const entry = registry.get(providerId);
    try {
      const { model } = await registry.resolveActive();
      return { label: `${model.name} · ${entry?.label ?? providerId}`, ok: true, needsKey: false };
    } catch (err) {
      const available = entry ? await entry.isAvailable() : false;
      return {
        label: entry?.label ?? providerId,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        needsKey: providerId === 'anthropic' && !available,
      };
    }
  }

  private roots(): Promise<string[]> {
    // Short-lived: the Git extension finds repositories a little after startup.
    if (!this.rootsCache || Date.now() - this.rootsCache.at > ROOTS_TTL_MS) {
      this.rootsCache = { at: Date.now(), roots: this.deps.repos.roots() };
    }
    return this.rootsCache.roots;
  }

  private clearCaches(): void {
    this.branchCache.clear();
    this.rootsCache = undefined;
    this.modelCache = undefined;
  }

  private async branches(root: string): Promise<string[]> {
    let list = this.branchCache.get(root);
    if (!list) {
      list = await this.deps.repos.branches(root);
      this.branchCache.set(root, list);
    }
    return list;
  }

  private async handle(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const { type, value } = msg as { type?: unknown; value?: unknown };
    switch (type) {
      case 'ready':
        return this.refresh();
      case 'scope':
        if (SCOPES.includes(value as PanelScope)) await this.update({ scope: value as PanelScope });
        return;
      case 'root':
        if (value === '' || (await this.roots()).includes(value as string)) {
          await this.update({ root: value as string });
        }
        return;
      case 'base': {
        const base = typeof value === 'string' ? value.trim() : '';
        if (base && !isSafeRef(base)) {
          void vscode.window.showWarningMessage(`AI Review: "${base}" is not a valid branch name.`);
          return this.refresh();
        }
        await this.update({ base });
        return;
      }
      case 'reviewMode':
        if (REVIEW_MODES.includes(value as (typeof REVIEW_MODES)[number])) {
          await writeSetting('reviewMode', value);
        }
        return;
      case 'includeContext':
        if (typeof value === 'boolean') await writeSetting('includeContext', value);
        return;
      case 'run':
        // A double click must not start a second review that cancels the first.
        if (!isReviewRunning()) await this.run();
        return;
      case 'cancel':
        cancelReview();
        return;
      case 'command':
        if (typeof value === 'string' && PANEL_COMMANDS.has(value)) {
          await vscode.commands.executeCommand(value);
        }
        return;
    }
  }

  private scheduleRefresh(): void {
    if (!this.view?.visible) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 100);
  }

  private async refresh(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const seq = ++this.refreshSeq;
    try {
      const state = await this.snapshot();
      if (seq !== this.refreshSeq || this.view !== view) return;
      await view.webview.postMessage({ type: 'state', state });
    } catch (err) {
      this.deps.logger.debug(`panel refresh failed: ${String(err)}`);
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    vscode.Disposable.from(...this.subscriptions).dispose();
  }
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(key, value, targetFor(config, key));
}

/** Folder name, or the path relative to the workspace when names repeat. */
function label(root: string, roots: string[]): string {
  const name = path.basename(root);
  if (roots.filter((r) => path.basename(r) === name).length === 1) return name;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  return folder ? relativeToRepo(folder.uri.fsPath, root) || folder.name : root;
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}
