import { describeMode, estimateCostUsd, type ReviewReport } from '@ai-review/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FindingStore, ReviewSession } from './store';

/** The current review as a report: findings with the lines and status they have now. */
export function sessionReport(store: FindingStore): ReviewReport | undefined {
  const session = store.session;
  if (!session) return undefined;
  const { model, result } = session;
  return {
    scope: describeMode(session.mode),
    model: model.name,
    finishedAt: session.finishedAt,
    result,
    findings: store.all(),
    ...(model.pricing ? { costUsd: estimateCostUsd(result.usage, model.pricing) } : {}),
  };
}

/** `ai-review-commits-abc1234-to-def5678-2026-11-26.md` in the repository root. */
export function defaultReportUri(session: ReviewSession): vscode.Uri {
  const slug = describeMode(session.mode)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  const d = session.finishedAt;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return vscode.Uri.file(path.join(session.root, `ai-review-${slug || 'review'}-${date}.md`));
}
