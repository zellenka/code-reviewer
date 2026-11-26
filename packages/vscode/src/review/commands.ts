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
  prepareDiff,
  removeExcluded,
  runReview,
  type Finding,
  type Logger,
  type ModelInfo,
  type ReviewEstimate,
  type ReviewMode,
  type ReviewResult,
  type Severity,
  type SkippedFile,
} from '@ai-review/core';
import { loadRepoRulesFromDisk } from '@ai-review/node-host';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showProviderError } from '../providers/errorUi';
import type { ProviderRegistry } from '../providers/registry';
import {
  USER_ONLY_SETTINGS,
  agentLimitSettings,
  costThreshold,
  excludeFileGlobs,
  reviewRunSettings,
  setInWorkspace,
} from '../settings';
import type { ReviewConfigService } from './config';
import type { ContentExclusion } from './exclusion';
import { relativeToRepo, unsavedFiles, type RepoLocator } from './repo';
import type { ReviewRuns } from './runs';
import type { SnapshotStore } from './snapshots';
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
  /** No notifications. Tests only: dropped outside `ExtensionMode.Test` (see `trustedReviewArgs`). */
  silent?: boolean;
  /**
   * Skip the cost confirmation. Tests only, like `silent`. Silent runs otherwise stop where
   * it would be asked.
   */
  confirmCost?: boolean;
  /**
   * Unstaged reviews: send the untracked files (true) or leave them out (false) without
   * asking. Tests only, like `silent`. Silent runs leave them out unless this is true.
   */
  includeUntracked?: boolean;
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
  runs: ReviewRuns;
  /** Last complete review per scope, for incremental re-reviews. */
  snapshots?: SnapshotStore;
  /** Files never sent: `aiReview.excludeFiles` and Copilot's content exclusion. */
  exclusion: ContentExclusion;
}

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
  /** Cancelled before any part finished: there's nothing new to show, so the last review stays. */
  const keepPrevious = (
    outcome: Pick<ReviewCommandResult, 'result' | 'estimate'> = {},
  ): ReviewCommandResult => {
    logger.info('review cancelled before any part finished; the previous findings are kept');
    notify(deps.store.session ? 'Cancelled. The previous findings are kept.' : 'Cancelled.');
    return { ok: false, message: 'cancelled', ...outcome };
  };

  if (!vscode.workspace.isTrusted) {
    const message =
      'This workspace is not trusted. AI Review sends code to a model, so it only runs in trusted workspaces.';
    notify(message, 'error');
    return { ok: false, message };
  }

  // Starting a new review cancels the previous one.
  const run = deps.runs.start();

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
    // The repo's config with the user's settings; what the repo turned down goes in the result.
    const { config, relaxed } = await deps.configs.get(repo.root);
    const runSettings = reviewRunSettings(settings);
    // "Review Selection" sends only the selected lines, so no surrounding code.
    const includeContext = runSettings.includeContext && mode.kind !== 'selection';
    const agentLimits = agentLimitSettings(settings);
    // VS Code already ignores these in workspace settings (scope "application"); say so in the log.
    const ignored = setInWorkspace(settings, USER_ONLY_SETTINGS);
    if (ignored.length) {
      logger.warn(
        `ignored in workspace settings, only user settings apply: ${ignored.map((k) => `aiReview.${k}`).join(', ')}`,
      );
    }
    const concurrency = settings.get<number>('concurrency') || undefined;
    const { summary, redactHighEntropy } = runSettings;
    const previous = runSettings.incremental ? deps.snapshots?.get(repo.root, mode) : undefined;
    // Answers are kept for this review only: the setting or Copilot's rules may change.
    const exclusion = deps.exclusion.forReview(repo.root, excludeFileGlobs(settings));
    // File and selection reviews read unsaved editor text; git diffs only see saved files,
    // so say which edits are left out. Staged reviews the index: unsaved edits aren't in it,
    // just like saved but unstaged ones, so it doesn't warn.
    const unsaved =
      mode.kind === 'unstaged' || mode.kind === 'branch' ? unsavedFiles(repo.root) : [];
    if (unsaved.length) {
      logger.warn(`unsaved changes are not included in this review: ${unsaved.join(', ')}`);
    }
    const withUnsavedNote = (message: string) =>
      unsaved.length
        ? `${message.replace(/\.$/, '')}. Not included: unsaved changes in ${listFiles(unsaved)} (save to review them).`
        : message;

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
          run.token.onCancellationRequested(() => controller.abort()),
        ];
        // Cancelled already (e.g. while the repository was looked up).
        if (token.isCancellationRequested || run.token.isCancellationRequested) controller.abort();
        try {
          progress.report({ message: 'collecting changes…' });
          let diff = await repo.source.getDiff(mode);
          // Nothing was reviewed, so nothing changes (not even for an empty diff).
          if (controller.signal.aborted) return { cancelled: true as const };
          if (!diff.files.length) return { empty: true as const };

          // Excluded files are taken out first: nothing below asks about them, counts their
          // cost or sends them (and core checks again). A file review of one is refused.
          const removed = await removeExcluded(diff, exclusion.isExcluded, controller.signal);
          if (controller.signal.aborted) return { cancelled: true as const };
          const excluded = removed.excluded;
          if (excluded.length && (mode.kind === 'file' || mode.kind === 'selection')) {
            const by = await exclusion.match(excluded[0]!.path, controller.signal);
            return {
              refused: true as const,
              message: `${excluded[0]!.path} is excluded from AI review${by === 'copilot' ? ' by Copilot content exclusion' : by === 'setting' ? ' by aiReview.excludeFiles' : ''}, so it isn't reviewed.`,
            };
          }
          diff = removed.diff;
          if (excluded.length) {
            logger.info(
              `leaving out ${excluded.length} file(s) excluded from AI review: ${excluded.map((f) => f.path).join(', ')}`,
            );
          }

          // Untracked files go only when the user says so, asked before the estimate so it
          // counts only what is sent. Files skipped anyway (secrets, binaries, …) aren't
          // asked about. Nothing is remembered: the next review asks again.
          const untracked = filterFiles(
            diff.files.filter((f) => f.untracked),
            config,
          ).files;
          let leftOut: SkippedFile[] = [];
          if (untracked.length) {
            const paths = untracked.map((f) => f.path);
            const include =
              args.includeUntracked ??
              (args.silent ? false : await askAboutUntracked(paths, model));
            if (include === undefined) return { declined: 'untracked' as const };
            if (!include) {
              const dropped = new Set(untracked);
              diff = { files: diff.files.filter((f) => !dropped.has(f)) };
              leftOut = paths.map((p) => ({ path: p, reason: 'untracked' as const }));
            }
            logger.info(
              `${include ? 'including' : 'leaving out'} ${paths.length} untracked file(s)${args.silent && args.includeUntracked === undefined ? ' (silent review)' : ''}: ${paths.join(', ')}`,
            );
          }
          if (controller.signal.aborted) return { cancelled: true as const };

          const rules = await loadRepoRulesFromDisk(repo.root, config, {
            logger,
            redactHighEntropy,
            isExcluded: (p) => exclusion.isExcluded(p, controller.signal),
          });
          const baseOptions = {
            model,
            config,
            redactHighEntropy,
            summary,
            rules,
            context: includeContext,
            workspace: new VsCodeWorkspaceTools(repo.root, logger, {
              ...(repo.gitPath ? { gitPath: repo.gitPath } : {}),
              // Untracked files the review doesn't send stay hidden from the agent's tools.
              untracked: mode.kind !== 'branch' && !leftOut.length,
            }),
            agentLimits,
            ...(relaxed.length ? { relaxed } : {}),
            ...(excluded.length || leftOut.length ? { leftOut: [...excluded, ...leftOut] } : {}),
            isExcluded: exclusion.isExcluded,
            ...(previous ? { previous } : {}),
          };
          // Filtered, redacted and planned once: for the symbols, the estimate and the review.
          const prepared = prepareDiff(diff, baseOptions);
          let symbols;
          if (includeContext) {
            progress.report({ message: 'reading code structure…' });
            symbols = await loadSymbols(
              prepared.files,
              new VsCodeSymbolProvider(repo.root, logger),
              { logger },
            );
          }
          // Don't ask about the cost of a review that was cancelled.
          if (controller.signal.aborted) return { cancelled: true as const };
          const reviewOptions = { ...baseOptions, ...(symbols ? { symbols } : {}) };
          const estimate = estimateReview(prepared, reviewOptions);
          logger.info(describeEstimate(estimate, model));
          const threshold = costThreshold(settings);
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
            if (choice !== 'Run Review') return { declined: 'cost' as const, estimate };
          }
          if (!estimate.costUsd) progress.report({ message: `${estimate.requests} request(s)…` });

          let done = 0;
          const result = await runReview(prepared, {
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
              if (p.phase === 'verify') {
                progress.report({ message: `double-checking ${p.findings} finding(s)…` });
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
          // Once per review, with the other warnings about the review itself.
          const warning = exclusion.warning();
          if (warning) result.warnings = [...(result.warnings ?? []), warning];
          return { empty: false as const, result, estimate };
        } finally {
          subs.forEach((s) => s.dispose());
        }
      },
    );

    if ('refused' in outcome && outcome.refused) {
      const { message } = outcome;
      logger.warn(message);
      notify(message, 'warn');
      return { ok: false, message };
    }
    if ('needsConfirmation' in outcome) {
      return {
        ok: false,
        message: 'The estimated cost needs confirmation.',
        estimate: outcome.estimate,
      };
    }
    if ('declined' in outcome) {
      if (outcome.declined === 'untracked') {
        logger.info('review cancelled at the question about untracked files; nothing was sent');
        return { ok: false, message: 'cancelled' };
      }
      logger.info('review cancelled at the cost confirmation');
      return { ok: false, message: 'cancelled', estimate: outcome.estimate };
    }
    // A newer review cancelled this one; the findings, snapshot and summary are its now.
    if (!run.isCurrent) {
      logger.info('review superseded by a newer one; its results are dropped');
      return { ok: false, message: 'cancelled' };
    }
    if ('cancelled' in outcome) return keepPrevious();
    if (outcome.empty) {
      const message = withUnsavedNote(`No changes to review (${describeMode(mode)}).`);
      notify(message, unsaved.length ? 'warn' : 'info');
      deps.store.clear();
      await deps.snapshots?.set(repo.root, mode, undefined);
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
    // A cancelled review replaces the last one only once a part has finished.
    if (result.cancelled && !result.chunks.completed) return keepPrevious({ result, estimate });
    const findings = await deps.store.set(
      { root: repo.root, mode, model, result, finishedAt: new Date(), generation: run.generation },
      result.findings,
    );
    if (!findings) {
      logger.info('a newer review or Clear Findings replaced this review; its results are dropped');
      return { ok: false, message: 'cancelled' };
    }
    // Cancelled or incomplete (no snapshot): keep the last one, it still matches its hunks.
    // Superseded meanwhile: the newer review writes it.
    if (result.snapshot && run.isCurrent) {
      await deps.snapshots?.set(repo.root, mode, result.snapshot);
    }
    const message = withUnsavedNote(summarize(result, model));
    if (!args.silent) {
      const level = needsAttention(result) || unsaved.length ? 'warn' : 'info';
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
    // Superseded: the newer review's outcome is the one to show, not this one's error.
    if (!run.isCurrent) {
      logger.info(
        `review superseded by a newer one failed (${err instanceof Error ? err.message : String(err)}); only the newer one is shown`,
      );
      return { ok: false, message: 'cancelled' };
    }
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
    deps.runs.finish(run);
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

/** Paths shown in the question about untracked files; the rest are counted. */
const UNTRACKED_SHOWN = 10;

/**
 * Asks whether to send the untracked files too: true (with them), false (without them),
 * undefined (cancelled). Asked every time; the answer isn't remembered.
 */
async function askAboutUntracked(paths: string[], model: ModelInfo): Promise<boolean | undefined> {
  const WITH = 'Review with Them';
  const WITHOUT = 'Review without Them';
  // File names come from the repository: no line breaks that could fake text in the dialog.
  const shown = paths.slice(0, UNTRACKED_SHOWN).map((p) => p.replace(/[\p{Cc}]/gu, '?'));
  const more = paths.length - shown.length;
  const choice = await vscode.window.showWarningMessage(
    paths.length === 1
      ? `AI Review: send the untracked file ${shown[0]} to ${model.name} too?`
      : `AI Review: send ${paths.length} untracked files to ${model.name} too?`,
    {
      modal: true,
      detail: `Untracked files are new files git doesn't track yet. They may be notes, dumps or local files that don't belong in the review:\n\n${shown.join('\n')}${more ? `\n+${more} more` : ''}\n\nWithout them, only the changes to tracked files are reviewed.`,
    },
    WITH,
    WITHOUT,
  );
  return choice === WITH ? true : choice === WITHOUT ? false : undefined;
}

/** `a, b, c and 2 more`. */
function listFiles(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
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
  if (result.incremental) {
    parts.push(
      result.incremental.newHunks
        ? `${result.incremental.newHunks} changed hunk(s) re-reviewed, ${result.incremental.carried} finding(s) kept`
        : 'nothing changed since the last review',
    );
  }
  if (result.verify?.rejected) parts.push(`${result.verify.rejected} rejected on double-check`);
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
  if (result.warnings?.length) message += `. ${result.warnings.join(' ')}`;
  return message;
}

/** Shown as a warning: no part gave findings because they failed, or the review warns about itself. */
export function needsAttention(result: ReviewResult): boolean {
  return (!!result.errors.length && !result.findings.length) || !!result.warnings?.length;
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
  const verify = e.verify ? `, verify pass up to ${e.verify.maxRequests} more request(s)` : '';
  return `estimate for ${model.id} (${e.mode}): ${e.files} file(s), ${e.requests} request(s), ~${input} input tokens, ${e.outputTokens.low}–${e.outputTokens.high} output tokens${cost}${verify}`;
}

function logResult(result: ReviewResult, logger: Logger): void {
  for (const s of result.skipped) logger.info(`skipped ${s.path} (${s.reason})`);
  for (const d of result.dropped)
    logger.info(`dropped ${d.count} finding(s): ${DROP_REASON_LABELS[d.reason]}`);
  for (const e of result.errors) logger.warn(e);
  for (const w of result.warnings ?? []) logger.warn(w);
  if (result.redactions) logger.info(`${result.redactions} secret(s) redacted before sending`);
  if (result.rules?.length) logger.info(`repo rules applied: ${result.rules.join(', ')}`);
  if (result.incremental) {
    logger.info(
      `incremental: ${result.incremental.newHunks} new hunk(s) sent, ${result.incremental.reusedHunks} reused, ${result.incremental.carried} finding(s) carried over`,
    );
  }
}
