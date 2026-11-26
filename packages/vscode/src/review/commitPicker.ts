import type { ReviewMode } from '@ai-review/core';
import { commitSpan, type CommitInfo } from '@ai-review/node-host';
import * as vscode from 'vscode';

type CommitsMode = Extract<ReviewMode, { kind: 'commits' }>;

/**
 * Asks which of `commits` (newest first, from `RepoLocator.commits`) to review. Several may
 * be picked; the review covers the run from the oldest to the newest, so picks with commits
 * between them that weren't picked are confirmed first. Undefined = cancelled; a string is a
 * message (no commits).
 */
export async function pickCommits(
  commits: CommitInfo[],
): Promise<CommitsMode | string | undefined> {
  if (!commits.length) return 'This repository has no commits yet.';
  // Subjects and names come from the repository: no control characters in the list.
  const clean = (text: string) => text.replace(/[\p{Cc}]/gu, ' ');
  const picked = await vscode.window.showQuickPick(
    commits.map((c) => ({
      label: clean(c.subject) || '(no message)',
      description: `${c.shortId} · ${clean(c.author)} · ${formatDate(c.date)}`,
      id: c.id,
    })),
    {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder:
        'Commits to review (newest first). Several are reviewed together, from the oldest to the newest.',
    },
  );
  if (!picked?.length) return undefined;
  const span = commitSpan(
    commits,
    picked.map((p) => p.id),
  );
  if (!span) return undefined;
  if (span.unpicked) {
    const short = (id: string) => commits.find((c) => c.id === id)?.shortId ?? id.slice(0, 7);
    const REVIEW = `Review ${span.count} Commits`;
    const choice = await vscode.window.showWarningMessage(
      `AI Review: review all ${span.count} commits from ${short(span.oldest)} to ${short(span.newest)}?`,
      {
        modal: true,
        detail: `The commits you picked aren't next to each other. A review covers one run of commits, so the ${span.unpicked} commit(s) between them are reviewed too.`,
      },
      REVIEW,
    );
    if (choice !== REVIEW) return undefined;
  }
  return { kind: 'commits', oldest: span.oldest, newest: span.newest };
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}
