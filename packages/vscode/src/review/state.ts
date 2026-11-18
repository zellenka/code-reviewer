import {
  fingerprint,
  normalizeWhitespace,
  redactText,
  similarity,
  type Finding,
} from '@ai-review/core';
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
  /**
   * Quote without copied line numbers or +/- markers, whitespace collapsed, for the
   * fuzzy fallback. Older entries may still have the markers. Secrets stay redacted
   * (`Finding.redactedQuote`): this outlives the code.
   */
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
/** Quote similarity at which the same code quoted a little longer/shorter is the same finding. */
export const FUZZY_MATCH = 0.85;

/**
 * Remembers which findings the user dismissed or resolved, per workspace (P5-3), so a
 * new review doesn't bring them back. Matched by fingerprint, else by same file +
 * category and a quote of the same code (see `sameCode`: the model may quote slightly
 * differently, but a similar line with other code is another finding).
 */
export class FindingStatusStore {
  private entries: StoredEntry[];

  constructor(private readonly memento: vscode.Memento) {
    const saved = memento.get<unknown>(STATE_KEY);
    const entries = Array.isArray(saved) ? saved.filter(isEntry) : [];
    this.entries = entries.map(withoutSecrets);
    // Entries saved before quotes were redacted: rewrite them now, not at the next change.
    if (this.entries.some((e, i) => e !== entries[i])) {
      void this.memento.update(STATE_KEY, this.entries);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  lookup(root: string, finding: Finding): StoredStatus | undefined {
    const r = normalizeRoot(root);
    const sameFile = this.entries.filter((e) => e.root === r && e.file === finding.file);
    const exact = sameFile.find((e) => e.id === finding.id);
    if (exact) return exact.status;
    const quote = storedQuote(finding);
    let best: { entry: StoredEntry; score: number } | undefined;
    for (const e of sameFile) {
      if (e.category !== finding.category) continue;
      const score = sameCode(e.quote, finding, quote);
      if (score !== undefined && (!best || score > best.score)) best = { entry: e, score };
    }
    return best?.entry.status;
  }

  /** Saves the status; "open" forgets the finding (and fuzzy matches of it). */
  async set(root: string, finding: Finding, status: StoredStatus | 'open'): Promise<void> {
    const r = normalizeRoot(root);
    const quote = storedQuote(finding);
    this.entries = this.entries.filter(
      (e) =>
        !(
          e.root === r &&
          e.file === finding.file &&
          (e.id === finding.id ||
            (e.category === finding.category && sameCode(e.quote, finding, quote) !== undefined))
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

/** The quote as stored and compared: redacted if it has secrets, normalized. */
function storedQuote(finding: Finding): string {
  return normalizeQuote(finding.redactedQuote ?? finding.quote);
}

/**
 * An entry from before quotes were stored redacted, with its secrets redacted and its
 * id recomputed from that (an id hashed from a short secret could be guessed back).
 * Matches by the fuzzy fallback (or the id) as the finding's redacted quote. The same
 * entry when there is nothing to redact.
 */
function withoutSecrets(entry: StoredEntry): StoredEntry {
  const quote = redactText(entry.quote).text;
  if (quote === entry.quote) return entry;
  return { ...entry, quote, id: fingerprint(entry.file, entry.category, quote) };
}

/**
 * Drops line numbers or +/- markers the model copied from the prompt (as `locateQuote`
 * does when anchoring, which keeps them in the quote) and collapses whitespace.
 */
function normalizeQuote(quote: string): string {
  let lines = quote.split(/\r\n?|\n/);
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const numbered = /^\s*\d+\s+[+\- ]\s/;
  if (lines.length && lines.every((l) => numbered.test(l))) {
    lines = lines.map((l) => l.replace(numbered, ''));
  } else if (lines.length && lines.every((l) => /^[+\- ]/.test(l))) {
    lines = lines.map((l) => l.slice(1));
  }
  return normalizeWhitespace(lines.join('\n')).slice(0, MAX_QUOTE);
}

/**
 * Similarity of a stored quote and a finding's (both normalized) if they quote the same
 * code, else undefined. Same code: equal apart from whitespace, or one inside the other
 * (the model quoted a little more or less of the same lines) and still ≥ 0.85 similar.
 * A line finding's misquote is already replaced with the real lines when anchoring, so
 * any other difference is other code: `query(sqlA, …)` and `query(sqlB, …)` on two
 * lines are two findings, and so is a quoted line the user has since edited.
 * A file finding's quote isn't anchored, so for it similarity alone counts, as before.
 */
function sameCode(stored: string, finding: Finding, quote: string): number | undefined {
  const x = stored.replace(/\s+/g, '');
  const y = quote.replace(/\s+/g, '');
  if (finding.anchor !== 'file' && !(x && y && (x.includes(y) || y.includes(x)))) {
    return undefined;
  }
  const score = similarity(x, y);
  return score >= FUZZY_MATCH ? score : undefined;
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
