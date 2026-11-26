import { compileGlobs, type IsExcluded } from '@ai-review/core';
import * as path from 'node:path';
import type * as vscode from 'vscode';

/** Copilot Chat: it answers `vscode.lm.fileIsIgnored` (org content exclusion, `.copilotignore`). */
export const COPILOT_CHAT_ID = 'GitHub.copilot-chat';

/** A Copilot question that hasn't answered after this long counts as failed. */
const COPILOT_TIMEOUT_MS = 10_000;

/**
 * The one function of the proposed API `chatParticipantAdditions` used here. VS Code throws
 * "CANNOT use API proposal" unless the user enabled the proposal for this extension.
 */
interface LmIgnoredFiles {
  fileIsIgnored?(uri: vscode.Uri, token: vscode.CancellationToken): Thenable<boolean>;
}

/** Why Copilot's content exclusion couldn't be checked. */
export type CopilotUnavailable =
  /** This VS Code has no `vscode.lm.fileIsIgnored`. */
  | 'noApi'
  /** The proposed API isn't enabled for this extension (the call throws). */
  | 'proposal'
  /** Copilot Chat isn't installed or not running: nothing would answer. */
  | 'copilot'
  /** The call failed or timed out. */
  | 'failed';

export type CopilotAnswer = { excluded: boolean } | { unavailable: CopilotUnavailable };

/**
 * Asks Copilot whether its content exclusion covers a file (an absolute path). Never
 * rejects, except with the abort reason when `signal` is aborted.
 */
export type CopilotExclusionCheck = (file: string, signal: AbortSignal) => Promise<CopilotAnswer>;

/** What `copilotExclusionCheck` uses of VS Code (`vscode.lm`, `vscode.extensions`, …). */
export interface CopilotEnv {
  lm: unknown;
  copilotChat: () => { readonly isActive: boolean } | undefined;
  uri: (file: string) => vscode.Uri;
  tokenSource: () => vscode.CancellationTokenSource;
  timeoutMs?: number;
}

/**
 * The Copilot check through `vscode.lm.fileIsIgnored`. Without a provider (Copilot Chat not
 * running) VS Code answers "not ignored", so that answer only counts while Copilot Chat is
 * active.
 */
export function copilotExclusionCheck(env: CopilotEnv): CopilotExclusionCheck {
  return async (file, signal) => {
    signal.throwIfAborted();
    const lm = env.lm as LmIgnoredFiles;
    if (typeof lm.fileIsIgnored !== 'function') return { unavailable: 'noApi' };
    const cts = env.tokenSource();
    let onAbort = () => cts.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Asked first, so a disabled proposal is reported even when Copilot isn't running.
      const ignored = await Promise.race([
        lm.fileIsIgnored(env.uri(file), cts.token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            env.timeoutMs ?? COPILOT_TIMEOUT_MS,
          );
          onAbort = () => {
            cts.cancel();
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (!env.copilotChat()?.isActive) return { unavailable: 'copilot' };
      return { excluded: ignored === true };
    } catch (err) {
      signal.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      return { unavailable: /CANNOT use API proposal/i.test(message) ? 'proposal' : 'failed' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  };
}

/**
 * `aiReview.excludeFiles` as a matcher of repo-relative paths, the way GitHub's content
 * exclusion paths are written: a leading `/` anchors at the repo root, a pattern without `/`
 * matches a name at any depth, `***` is `**`. A pattern that matches a folder excludes
 * everything in it. Letter case is ignored.
 */
export function excludeFilesMatcher(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs
    .map((g) =>
      g
        .trim()
        .replace(/\\/g, '/')
        .replace(/\*{3,}/g, '**'),
    )
    .filter(Boolean);
  if (!patterns.length) return () => false;
  const match = compileGlobs(patterns, true);
  return (p) => {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.some((_, i) => match(parts.slice(0, i + 1).join('/')));
  };
}

/** What excludes a file: the user's `aiReview.excludeFiles`, or Copilot. */
export type ExclusionSource = 'setting' | 'copilot';

/** The exclusion of one review: answers are kept for the review. */
export interface ReviewExclusion {
  /** For core (`ReviewOptions.isExcluded`). */
  isExcluded: IsExcluded;
  /** What excludes `path` (repo-relative), if anything. */
  match(path: string, signal: AbortSignal): Promise<ExclusionSource | undefined>;
  /** The result's warning when Copilot's content exclusion wasn't checked, for any file. */
  warning(): string | undefined;
}

/**
 * Content exclusion for reviews: the user's `aiReview.excludeFiles` and, when VS Code and
 * Copilot Chat let it, Copilot's content exclusion. A file either one excludes is never sent.
 * `copilot` can be replaced (tests).
 */
export class ContentExclusion {
  constructor(
    public copilot: CopilotExclusionCheck,
    private readonly extensionId: string,
  ) {}

  forReview(root: string, globs: readonly string[]): ReviewExclusion {
    const inSetting = excludeFilesMatcher(globs);
    const answers = new Map<string, Promise<ExclusionSource | undefined>>();
    const unavailable = new Set<CopilotUnavailable>();
    /** Set once Copilot can't answer for any file: it isn't asked again in this review. */
    let skipCopilot = false;
    const ask = async (rel: string, signal: AbortSignal): Promise<ExclusionSource | undefined> => {
      if (inSetting(rel)) return 'setting';
      if (skipCopilot) return undefined;
      const answer = await this.copilot(path.join(root, ...rel.split('/')), signal);
      if ('excluded' in answer) return answer.excluded ? 'copilot' : undefined;
      unavailable.add(answer.unavailable);
      if (answer.unavailable !== 'failed') skipCopilot = true;
      return undefined;
    };
    const match = (rel: string, signal: AbortSignal) => {
      let answer = answers.get(rel);
      if (!answer) {
        const pending = ask(rel, signal);
        // A cancelled question is asked again next time.
        pending.catch(() => {
          if (answers.get(rel) === pending) answers.delete(rel);
        });
        answers.set(rel, pending);
        answer = pending;
      }
      return answer;
    };
    return {
      match,
      isExcluded: async (rel, signal) => (await match(rel, signal)) !== undefined,
      warning: () => copilotWarning(unavailable, this.extensionId),
    };
  }
}

/** Why Copilot couldn't answer, as the warning says it; the first that applies is named. */
const UNAVAILABLE: Record<CopilotUnavailable, string> = {
  noApi: 'this version of VS Code cannot tell which files it excludes.',
  proposal:
    'VS Code only lets AI Review ask Copilot when its proposed API is enabled for AI Review.',
  copilot: 'GitHub Copilot Chat is not installed or not running.',
  failed: 'asking Copilot failed for some files.',
};

/** The warning for a review whose Copilot check couldn't run: why, and how to turn it on. */
function copilotWarning(
  unavailable: ReadonlySet<CopilotUnavailable>,
  extensionId: string,
): string | undefined {
  const reason = (Object.keys(UNAVAILABLE) as CopilotUnavailable[]).find((r) => unavailable.has(r));
  if (!reason) return undefined;
  const enable =
    reason === 'proposal' || reason === 'copilot'
      ? ` To check it, add "enable-proposed-api": ["${extensionId}"] to argv.json (command "Preferences: Configure Runtime Arguments"), restart VS Code, and keep GitHub Copilot Chat installed and signed in.`
      : '';
  return `Copilot content exclusion was not checked: ${UNAVAILABLE[reason]}${enable} Files in aiReview.excludeFiles were still left out.`;
}
