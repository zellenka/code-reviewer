import {
  DROP_REASON_LABELS,
  ReviewTooLargeError,
  describeMode,
  estimateCostUsd,
  estimateReview,
  filterFiles,
  isDiffSourceError,
  loadSymbols,
  isProviderError,
  runReview,
  type Finding,
  type AgentLimits,
  type Logger,
  type ModelInfo,
  type ReviewConfig,
  type ReviewEstimate,
  type ReviewMode,
  type ReviewResult,
  type Severity,
} from '@ai-review/core';
import { loadRepoRulesFromDisk } from '@ai-review/node-host';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showProviderError } from '../providers/errorUi';
import type { ProviderRegistry } from '../providers/registry';
import type { ReviewConfigService } from './config';
import { relativeToRepo, type RepoLocator } from './repo';
import type { FindingStore } from './store';
import { formatTokens } from './tree';
import { VsCodeSymbolProvider, VsCodeWorkspaceTools } from './workspace';

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
  /** Skip the cost confirmation (tests). Silent runs otherwise stop where it would be asked. */
  confirmCost?: boolean;
}

export interface ReviewCommandResult {
  ok: boolean;
  result?: ReviewResult;
  /** Findings as shown (re-anchored to the working tree). */
  findings?: Finding[];
  message?: string;
  /** Pre-run estimate (requests, tokens, cost range). */
  estimate?: ReviewEstimate;
}

export interface ReviewDeps {
  registry: ProviderRegistry;
  repos: RepoLocator;
  configs: ReviewConfigService;
  store: FindingStore;
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
    const settings = vscode.workspace.getConfiguration('aiReview');
    const config = withModeSetting(await deps.configs.get(repo.root), settings);
    // "Review Selection" sends only the selected lines, so no surrounding code.
    const includeContext =
      (settings.get<boolean>('includeContext') ?? true) && mode.kind !== 'selection';
    const agentLimits = agentLimitSettings(settings);
    const concurrency = settings.get<number>('concurrency') || undefined;
    const summary = settings.get<boolean>('summary') ?? true;
    const redactHighEntropy = settings.get<boolean>('redactHighEntropyStrings') ?? false;

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

          const rules = await loadRepoRulesFromDisk(repo.root, config, {
            logger,
            redactHighEntropy,
          });
          let symbols;
          if (includeContext) {
            progress.report({ message: 'reading code structure…' });
            symbols = await loadSymbols(
              filterFiles(diff.files, config.ignore).files,
              new VsCodeSymbolProvider(repo.root, logger),
              { logger },
            );
          }
          const reviewOptions = {
            model,
            config,
            redactHighEntropy,
            summary,
            rules,
            context: includeContext,
            ...(symbols ? { symbols } : {}),
            workspace: new VsCodeWorkspaceTools(repo.root, logger),
            agentLimits,
          };
          const estimate = estimateReview(diff, reviewOptions);
          logger.info(describeEstimate(estimate, model));
          const threshold = settings.get<number>('costConfirmationThreshold') ?? 0.5;
          if (estimate.costUsd && estimate.costUsd.high > threshold && !args.confirmCost) {
            if (args.silent) return { needsConfirmation: true as const, estimate };
            const choice = await vscode.window.showWarningMessage(
              estimate.inputTokensHigh !== undefined
                ? `AI Review: this agentic review sends ${formatTokens(estimate.inputTokens)}–${formatTokens(estimate.inputTokensHigh)} tokens to ${model.name} (${estimate.requests} part(s), each may explore the repository). Estimated cost: ${formatUsd(estimate.costUsd.low)}–${formatUsd(estimate.costUsd.high)}.`
                : `AI Review: this review sends about ${formatTokens(estimate.inputTokens)} tokens in ${estimate.requests} request(s) to ${model.name}. Estimated cost: ${formatUsd(estimate.costUsd.low)}–${formatUsd(estimate.costUsd.high)}.`,
              {
                modal: true,
                detail: `That's above your confirmation threshold of ${formatUsd(threshold)} (setting aiReview.costConfirmationThreshold). Narrow the scope to make it cheaper.`,
              },
              'Run Review',
            );
            if (choice !== 'Run Review') return { declined: true as const, estimate };
          }
          if (!estimate.costUsd) progress.report({ message: `${estimate.requests} request(s)…` });

          let done = 0;
          const result = await runReview(diff, {
            ...reviewOptions,
            provider,
            signal: controller.signal,
            logger,
            ...(concurrency ? { concurrency } : {}),
            onProgress: (p) => {
              if (p.phase === 'summary') {
                progress.report({ message: 'writing the summary…' });
                return;
              }
              const increment = p.chunksTotal ? ((p.chunksDone - done) / p.chunksTotal) * 100 : 0;
              done = p.chunksDone;
              progress.report({
                increment,
                message: `${p.chunksDone}/${p.chunksTotal} part(s) · ${p.findings} finding(s) so far`,
              });
            },
          });
          return { empty: false as const, result, estimate };
        } finally {
          subs.forEach((s) => s.dispose());
        }
      },
    );

    if ('needsConfirmation' in outcome) {
      return {
        ok: false,
        message: 'The estimated cost needs confirmation.',
        estimate: outcome.estimate,
      };
    }
    if ('declined' in outcome) {
      logger.info('review cancelled at the cost confirmation');
      return { ok: false, message: 'cancelled', estimate: outcome.estimate };
    }
    if (outcome.empty) {
      const message = `No changes to review (${describeMode(mode)}).`;
      notify(message);
      deps.store.clear();
      return { ok: true, findings: [], message };
    }

    const { result, estimate } = outcome;
    logResult(result, logger);
    const actualInput =
      result.usage.inputTokens +
      (result.usage.cacheReadTokens ?? 0) +
      (result.usage.cacheWriteTokens ?? 0);
    logger.info(
      `input tokens: estimated ${estimate.inputTokens}, actual ${actualInput}${result.usage.estimated ? ' (counted locally)' : ''}`,
    );
    const findings = await deps.store.set(
      { root: repo.root, mode, model, result, finishedAt: new Date() },
      result.findings,
    );
    const message = summarize(result, model);
    if (!args.silent) {
      const level = result.errors.length && !result.findings.length ? 'warn' : 'info';
      const show =
        level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const actions = [
        findings.length ? 'Show Findings' : undefined,
        result.summary ? 'Show Summary' : undefined,
        result.errors.length ? 'Show Log' : undefined,
      ].filter((a): a is string => !!a);
      void show(`AI Review: ${message}`, ...actions).then((choice) => {
        if (choice === 'Show Findings')
          void vscode.commands.executeCommand('aiReview.findings.focus');
        if (choice === 'Show Summary') void vscode.commands.executeCommand('aiReview.showSummary');
        if (choice === 'Show Log') void vscode.commands.executeCommand('aiReview.showLog');
      });
    }
    return { ok: true, result, findings, message, estimate };
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

/** `aiReview.reviewMode` overrides the repository's `review.mode` unless it is "auto". */
function withModeSetting(
  config: ReviewConfig,
  settings: vscode.WorkspaceConfiguration,
): ReviewConfig {
  const mode = settings.get<string>('reviewMode');
  if (mode !== 'single-pass' && mode !== 'agentic') return config;
  return { ...config, review: { ...config.review, mode } };
}

function agentLimitSettings(settings: vscode.WorkspaceConfiguration): Partial<AgentLimits> {
  const limits: Partial<AgentLimits> = {};
  const read = (key: string) => {
    const value = settings.get<number>(key);
    return typeof value === 'number' && value > 0 ? value : undefined;
  };
  const maxTurns = read('agent.maxTurns');
  const maxToolCalls = read('agent.maxToolCalls');
  const tokenBudget = read('agent.tokenBudget');
  if (maxTurns) limits.maxTurns = maxTurns;
  if (maxToolCalls) limits.maxToolCalls = maxToolCalls;
  if (tokenBudget) limits.tokenBudget = tokenBudget;
  return limits;
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

export function summarize(result: ReviewResult, model?: ModelInfo): string {
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
  if (result.agent) parts.push(`${result.agent.toolCalls} tool call(s)`);
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
  const tokens = result.usage.inputTokens + result.usage.outputTokens;
  if (tokens)
    parts.push(`${formatTokens(tokens)} tokens${result.usage.estimated ? ' (est.)' : ''}`);
  if (model?.pricing) parts.push(`≈ ${formatUsd(estimateCostUsd(result.usage, model.pricing))}`);
  else if (result.usage.requests) parts.push(`${result.usage.requests} request(s)`);
  let message = parts.join(' · ');
  if (result.cancelled) message = `Cancelled. ${message} (from finished parts)`;
  if (result.errors.length) message += ` · ${result.errors.length} part(s) failed`;
  return message;
}

export function formatUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function describeEstimate(e: ReviewEstimate, model: ModelInfo): string {
  const cost = e.costUsd ? `, ${formatUsd(e.costUsd.low)}–${formatUsd(e.costUsd.high)}` : '';
  const input =
    e.inputTokensHigh !== undefined
      ? `${e.inputTokens}–${e.inputTokensHigh}`
      : String(e.inputTokens);
  return `estimate for ${model.id} (${e.mode}): ${e.files} file(s), ${e.requests} request(s), ~${input} input tokens, ${e.outputTokens.low}–${e.outputTokens.high} output tokens${cost}`;
}

function logResult(result: ReviewResult, logger: Logger): void {
  for (const s of result.skipped) logger.info(`skipped ${s.path} (${s.reason})`);
  for (const d of result.dropped)
    logger.info(`dropped ${d.count} finding(s): ${DROP_REASON_LABELS[d.reason]}`);
  for (const e of result.errors) logger.warn(e);
  if (result.redactions) logger.info(`${result.redactions} secret(s) redacted before sending`);
  if (result.rules?.length) logger.info(`repo rules applied: ${result.rules.join(', ')}`);
}
