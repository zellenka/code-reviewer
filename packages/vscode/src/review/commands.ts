import {
  DROP_REASON_LABELS,
  ReviewTooLargeError,
  describeMode,
  isDiffSourceError,
  isProviderError,
  runReview,
  type Finding,
  type Logger,
  type ReviewMode,
  type ReviewResult,
  type Severity,
} from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showProviderError } from '../providers/errorUi';
import type { ProviderRegistry } from '../providers/registry';
import type { ReviewConfigService } from './config';
import type { FindingsDiagnostics } from './diagnostics';
import { relativeToRepo, type RepoLocator } from './repo';

export type ReviewKind = ReviewMode['kind'];

/** Optional command arguments (tests, keybindings). Without them the active editor is used. */
export interface ReviewCommandArgs {
  /** Repo (or any folder/file inside it). */
  root?: string;
  /** Repo-relative or absolute path, for file/selection. */
  path?: string;
  startLine?: number;
  endLine?: number;
  base?: string;
  /** No notifications (tests). */
  silent?: boolean;
}

export interface ReviewCommandResult {
  ok: boolean;
  result?: ReviewResult;
  /** Findings as shown (re-anchored to the working tree). */
  findings?: Finding[];
  message?: string;
}

export interface ReviewDeps {
  registry: ProviderRegistry;
  repos: RepoLocator;
  configs: ReviewConfigService;
  diagnostics: FindingsDiagnostics;
  logger: Logger;
}

let running: vscode.CancellationTokenSource | undefined;

export async function reviewCommand(
  kind: ReviewKind,
  deps: ReviewDeps,
  args: ReviewCommandArgs = {},
  uri?: vscode.Uri,
): Promise<ReviewCommandResult> {
  const { logger } = deps;
  const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    if (args.silent) return;
    const show =
      level === 'error'
        ? vscode.window.showErrorMessage
        : level === 'warn'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    void show(`AI Review: ${message}`);
  };

  if (!vscode.workspace.isTrusted) {
    const message =
      'This workspace is not trusted. AI Review sends code to a model, so it only runs in trusted workspaces.';
    notify(message, 'error');
    return { ok: false, message };
  }

  // Starting a new review cancels the previous one.
  running?.cancel();
  const cts = new vscode.CancellationTokenSource();
  running = cts;

  try {
    const editor = vscode.window.activeTextEditor;
    const fileTarget =
      args.path ??
      uri?.fsPath ??
      (editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined);
    if ((kind === 'file' || kind === 'selection') && !fileTarget) {
      const message = 'Open a file to review it.';
      notify(message, 'warn');
      return { ok: false, message };
    }

    // An absolute file path identifies its repo; a relative one needs `root` (or the active repo).
    const fileHint =
      (kind === 'file' || kind === 'selection') && fileTarget && path.isAbsolute(fileTarget)
        ? fileTarget
        : undefined;
    const repo = await deps.repos.resolve(args.root ?? fileHint);
    if (!repo) return { ok: false, message: 'cancelled' };

    const mode = buildMode(kind, repo.root, fileTarget, args, editor);
    if (typeof mode === 'string') {
      notify(mode, 'warn');
      return { ok: false, message: mode };
    }

    const { provider, model } = await deps.registry.resolveActive();
    const config = await deps.configs.get(repo.root);
    const settings = vscode.workspace.getConfiguration('aiReview');
    const concurrency = settings.get<number>('concurrency') || undefined;

    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI Review: reviewing ${describeMode(mode)} with ${model.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        const subs = [
          token.onCancellationRequested(() => controller.abort()),
          cts.token.onCancellationRequested(() => controller.abort()),
        ];
        try {
          progress.report({ message: 'collecting changes…' });
          const diff = await repo.source.getDiff(mode);
          if (!diff.files.length) return { empty: true as const };
          let done = 0;
          const result = await runReview(diff, {
            provider,
            model,
            config,
            signal: controller.signal,
            logger,
            redactHighEntropy: settings.get<boolean>('redactHighEntropyStrings') ?? false,
            ...(concurrency ? { concurrency } : {}),
            onProgress: (p) => {
              const increment = p.chunksTotal ? ((p.chunksDone - done) / p.chunksTotal) * 100 : 0;
              done = p.chunksDone;
              progress.report({
                increment,
                message: `${p.chunksDone}/${p.chunksTotal} part(s) · ${p.findings} finding(s) so far`,
              });
            },
          });
          return { empty: false as const, result };
        } finally {
          subs.forEach((s) => s.dispose());
        }
      },
    );

    if (outcome.empty) {
      const message = `No changes to review (${describeMode(mode)}).`;
      notify(message);
      deps.diagnostics.clear();
      return { ok: true, findings: [], message };
    }

    const { result } = outcome;
    logResult(result, logger);
    const findings = await deps.diagnostics.show(repo.root, result.findings);
    const message = summarize(result);
    if (!args.silent) {
      const level = result.errors.length && !result.findings.length ? 'warn' : 'info';
      const show =
        level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const actions = [
        findings.length ? 'Show Problems' : undefined,
        result.errors.length ? 'Show Log' : undefined,
      ].filter((a): a is string => !!a);
      void show(`AI Review: ${message}`, ...actions).then((choice) => {
        if (choice === 'Show Problems')
          void vscode.commands.executeCommand('workbench.actions.view.problems');
        if (choice === 'Show Log') void vscode.commands.executeCommand('aiReview.showLog');
      });
    }
    return { ok: true, result, findings, message };
  } catch (err) {
    if (isDiffSourceError(err) || err instanceof ReviewTooLargeError || isTooLarge(err)) {
      const message = (err as Error).message;
      logger.warn(message);
      notify(message, 'warn');
      return { ok: false, message };
    }
    if (isProviderError(err) && !args.silent) await showProviderError(err, logger);
    else if (!args.silent) {
      logger.error(err instanceof Error ? err : String(err));
      notify(`Review failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } else logger.error(err instanceof Error ? err : String(err));
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (running === cts) running = undefined;
    cts.dispose();
  }
}

function isTooLarge(err: unknown): boolean {
  return err instanceof Error && err.name === 'ReviewTooLargeError';
}

function buildMode(
  kind: ReviewKind,
  root: string,
  fileTarget: string | undefined,
  args: ReviewCommandArgs,
  editor: vscode.TextEditor | undefined,
): ReviewMode | string {
  switch (kind) {
    case 'unstaged':
    case 'staged':
      return { kind };
    case 'branch':
      return args.base ? { kind, base: args.base } : { kind };
    case 'file':
    case 'selection': {
      const rel = toRepoPath(root, fileTarget!);
      if (!rel) return 'This file is not inside the repository.';
      if (kind === 'file') return { kind, path: rel };
      let startLine = args.startLine;
      let endLine = args.endLine;
      if (startLine === undefined || endLine === undefined) {
        const sel = editor?.selection;
        if (!sel || sel.isEmpty) return 'Select some code to review.';
        startLine = sel.start.line + 1;
        // A selection ending at column 0 doesn't include that line.
        endLine =
          sel.end.character === 0 && sel.end.line > sel.start.line
            ? sel.end.line
            : sel.end.line + 1;
      }
      return { kind, path: rel, startLine, endLine };
    }
  }
}

function toRepoPath(root: string, target: string): string | undefined {
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(target);
  return isAbsolute ? relativeToRepo(root, target) : target.replace(/\\/g, '/');
}

const ORDER: Severity[] = ['critical', 'major', 'minor', 'nit'];

export function summarize(result: ReviewResult): string {
  const parts: string[] = [];
  if (result.findings.length) {
    const counts = ORDER.map(
      (s) => [s, result.findings.filter((f) => f.severity === s).length] as const,
    )
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    parts.push(`${result.findings.length} finding(s) (${counts.join(', ')})`);
  } else {
    parts.push('no issues found');
  }
  parts.push(`${result.reviewedFiles.length} file(s) reviewed`);
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
  const tokens = result.usage.inputTokens + result.usage.outputTokens;
  if (tokens)
    parts.push(`${formatTokens(tokens)} tokens${result.usage.estimated ? ' (est.)' : ''}`);
  let message = parts.join(' · ');
  if (result.cancelled) message = `Cancelled. ${message} (from finished parts)`;
  if (result.errors.length) message += ` · ${result.errors.length} part(s) failed`;
  return message;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function logResult(result: ReviewResult, logger: Logger): void {
  for (const s of result.skipped) logger.info(`skipped ${s.path} (${s.reason})`);
  for (const d of result.dropped)
    logger.info(`dropped ${d.count} finding(s): ${DROP_REASON_LABELS[d.reason]}`);
  for (const e of result.errors) logger.warn(e);
  if (result.redactions) logger.info(`${result.redactions} secret(s) redacted before sending`);
}
