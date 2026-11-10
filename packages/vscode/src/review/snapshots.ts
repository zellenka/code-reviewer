import type { ReviewMode, ReviewSnapshot } from '@ai-review/core';
import * as path from 'node:path';
import type * as vscode from 'vscode';

const STATE_KEY = 'aiReview.reviewSnapshots.v1';
/** Scopes remembered per workspace (most recent kept). */
const MAX_SNAPSHOTS = 10;

interface Entry {
  key: string;
  at: number;
  snapshot: ReviewSnapshot;
}

/**
 * The last complete review per repo and scope (P5-4), so the next review of the same
 * scope only sends hunks that changed. Selection reviews are never incremental.
 */
export class SnapshotStore {
  private entries: Entry[];

  constructor(private readonly memento: vscode.Memento) {
    const saved = memento.get<unknown>(STATE_KEY);
    this.entries = Array.isArray(saved)
      ? saved.filter(
          (e): e is Entry =>
            !!e &&
            typeof e.key === 'string' &&
            e.snapshot?.version === 1 &&
            Array.isArray(e.snapshot.findings) &&
            Array.isArray(e.snapshot.findingHunks) &&
            typeof e.at === 'number',
        )
      : [];
  }

  get(root: string, mode: ReviewMode): ReviewSnapshot | undefined {
    const key = scopeKey(root, mode);
    return key ? this.entries.find((e) => e.key === key)?.snapshot : undefined;
  }

  async set(root: string, mode: ReviewMode, snapshot: ReviewSnapshot | undefined): Promise<void> {
    const key = scopeKey(root, mode);
    if (!key) return;
    this.entries = this.entries.filter((e) => e.key !== key);
    if (snapshot) {
      this.entries.push({ key, at: Date.now(), snapshot });
      this.entries.sort((a, b) => a.at - b.at);
      this.entries = this.entries.slice(-MAX_SNAPSHOTS);
    }
    await this.memento.update(STATE_KEY, this.entries);
  }

  /** Forgets every scope: the next reviews send everything again. */
  async clear(): Promise<void> {
    this.entries = [];
    await this.memento.update(STATE_KEY, undefined);
  }
}

function scopeKey(root: string, mode: ReviewMode): string | undefined {
  const resolved = path.resolve(root);
  const r = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  switch (mode.kind) {
    case 'unstaged':
    case 'staged':
      return `${r}|${mode.kind}`;
    case 'branch':
      return `${r}|branch|${mode.base ?? ''}`;
    case 'file':
      return `${r}|file|${mode.path}`;
    case 'selection':
      return undefined;
  }
}
