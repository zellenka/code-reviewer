import { normalizeWhitespace, similarity, type Finding } from '@ai-review/core';
import * as path from 'node:path';
import type * as vscode from 'vscode';

/** Status a user gave a finding; "open" is the default and isn't stored. */
export type StoredStatus = 'dismissed' | 'resolved';

interface StoredEntry {
  /** Repo root, normalized (several repos can share a workspace). */
  root: string;
  id: string;
  file: string;
  category: string;
  /** Whitespace-normalized quote, for the fuzzy fallback. */
  quote: string;
  status: StoredStatus;
  /** Last change, ms since epoch; the oldest entries go first when the cap is hit. */
  at: number;
}

const STATE_KEY = 'aiReview.findingStatus.v1';
/** Entries kept per workspace. */
const MAX_ENTRIES = 2_000;
/** Longest quote kept for fuzzy matching. */
const MAX_QUOTE = 1_000;
/** Quote similarity at which a reworded/re-anchored finding counts as the same one. */
export const FUZZY_MATCH = 0.85;

/**
 * Remembers which findings the user dismissed or resolved, per workspace (P5-3), so a
 * new review doesn't bring them back. Matched by fingerprint, else by same file +
 * category and a quote similarity ≥ 0.85 (the model may quote slightly differently).
 */
export class FindingStatusStore {
  private entries: StoredEntry[];

  constructor(private readonly memento: vscode.Memento) {
    const saved = memento.get<unknown>(STATE_KEY);
    this.entries = Array.isArray(saved) ? saved.filter(isEntry) : [];
  }

  get size(): number {
    return this.entries.length;
  }

  lookup(root: string, finding: Finding): StoredStatus | undefined {
    const r = normalizeRoot(root);
    const sameFile = this.entries.filter((e) => e.root === r && e.file === finding.file);
    const exact = sameFile.find((e) => e.id === finding.id);
    if (exact) return exact.status;
    const quote = normalizeQuote(finding.quote);
    let best: { entry: StoredEntry; score: number } | undefined;
    for (const e of sameFile) {
      if (e.category !== finding.category) continue;
      const score = similarity(e.quote, quote);
      if (score >= FUZZY_MATCH && (!best || score > best.score)) best = { entry: e, score };
    }
    return best?.entry.status;
  }

  /** Saves the status; "open" forgets the finding (and fuzzy matches of it). */
  async set(root: string, finding: Finding, status: StoredStatus | 'open'): Promise<void> {
    const r = normalizeRoot(root);
    const quote = normalizeQuote(finding.quote);
    this.entries = this.entries.filter(
      (e) =>
        !(
          e.root === r &&
          e.file === finding.file &&
          (e.id === finding.id ||
            (e.category === finding.category && similarity(e.quote, quote) >= FUZZY_MATCH))
        ),
    );
    if (status !== 'open') {
      this.entries.push({
        root: r,
        id: finding.id,
        file: finding.file,
        category: finding.category,
        quote,
        status,
        at: Date.now(),
      });
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.sort((a, b) => a.at - b.at);
        this.entries = this.entries.slice(-MAX_ENTRIES);
      }
    }
    await this.memento.update(STATE_KEY, this.entries);
  }

  async clear(): Promise<number> {
    const n = this.entries.length;
    this.entries = [];
    await this.memento.update(STATE_KEY, undefined);
    return n;
  }
}

function normalizeQuote(quote: string): string {
  return normalizeWhitespace(quote).slice(0, MAX_QUOTE);
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isEntry(value: unknown): value is StoredEntry {
  const e = value as StoredEntry;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.root === 'string' &&
    typeof e.id === 'string' &&
    typeof e.file === 'string' &&
    typeof e.category === 'string' &&
    typeof e.quote === 'string' &&
    (e.status === 'dismissed' || e.status === 'resolved') &&
    typeof e.at === 'number'
  );
}
