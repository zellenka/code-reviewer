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

/**
 * `review-summary-2026-11-26.md` in the repository root, or `-2`, `-3`… when another
 * review already saved one that day.
 */
export async function newReportUri(session: ReviewSession): Promise<vscode.Uri> {
  const d = session.finishedAt;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `review-summary-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  for (let n = 1; ; n++) {
    const uri = vscode.Uri.file(
      path.join(session.root, n === 1 ? `${base}.md` : `${base}-${n}.md`),
    );
    if (!(await exists(uri))) return uri;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
