import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import picomatch from 'picomatch';
import {
  isProtectedPath,
  normalizeEol,
  splitLines,
  toPosixPath,
  type WorkspaceTools,
} from '@ai-review/core';
import { realRepoPath, resolveInRepo } from './sandbox';

export interface FsWorkspaceToolsOptions {
  /** Max characters returned by `readFile`. Default 100k. */
  maxReadChars?: number;
  /** Max grep matches. Default 200. */
  maxGrepResults?: number;
  /** Directory names never searched. */
  skipDirs?: string[];
  /** A grep whose regex takes longer than this on one batch of files fails. Default 3s. */
  grepTimeoutMs?: number;
}

const DEFAULT_SKIP = [
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.vscode-test',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
];
const MAX_GREP_FILE_BYTES = 1024 * 1024;
/** Text sent to the grep worker at once. */
const GREP_BATCH_CHARS = 1024 * 1024;

/**
 * Regex matching runs in a worker: the pattern comes from the model, and a catastrophic
 * one (e.g. `(a+)+$`) would otherwise block the whole host (in VS Code: every extension).
 * The worker is killed when a batch takes too long.
 */
const GREP_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData);
parentPort.on('message', (texts) => {
  const hits = [];
  for (let f = 0; f < texts.length; f++) {
    const lines = texts[f].split('\\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push([f, i]);
  }
  parentPort.postMessage(hits);
});
`;

/** Read-only file tools sandboxed to the repo root (no LSP: references fall back to grep). */
export class FsWorkspaceTools implements WorkspaceTools {
  readonly root: string;
  private readonly maxReadChars: number;
  private readonly maxGrepResults: number;
  private readonly skipDirs: Set<string>;
  private readonly grepTimeoutMs: number;

  constructor(root: string, options: FsWorkspaceToolsOptions = {}) {
    this.root = path.resolve(root);
    this.maxReadChars = options.maxReadChars ?? 100_000;
    this.maxGrepResults = options.maxGrepResults ?? 200;
    this.skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP);
    this.grepTimeoutMs = options.grepTimeoutMs ?? 3_000;
  }

  async readFile(relPath: string, range?: { start: number; end: number }): Promise<string> {
    const abs = await resolveInRepo(this.root, relPath);
    // Callers check the name they ask for; this checks what a symlink points to.
    if (isProtectedPath(await realRepoPath(this.root, abs))) {
      throw new Error(`${relPath} can't be read: it may contain secrets.`);
    }
    let text = normalizeEol(await readFile(abs, 'utf8'));
    if (range) {
      const lines = splitLines(text);
      const start = Math.max(1, range.start);
      const end = Math.min(lines.length, range.end);
      text = lines.slice(start - 1, end).join('\n');
    }
    if (text.length > this.maxReadChars) {
      text = `${text.slice(0, this.maxReadChars)}\n… [truncated at ${this.maxReadChars} characters]`;
    }
    return text;
  }

  async grep(
    pattern: string,
    glob?: string,
  ): Promise<{ path: string; line: number; text: string }[]> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    const matchGlob = glob ? picomatch(glob, { dot: true }) : undefined;
    const results: { path: string; line: number; text: string }[] = [];
    const worker = new Worker(GREP_WORKER, { eval: true, workerData: regex.source });
    worker.unref();
    let batch: { rel: string; lines: string[] }[] = [];
    let batchChars = 0;

    const flush = async () => {
      if (!batch.length) return;
      const files = batch;
      batch = [];
      batchChars = 0;
      const hits = await this.matchInWorker(
        worker,
        files.map((f) => f.lines.join('\n')),
      );
      for (const [f, i] of hits) {
        if (results.length >= this.maxGrepResults) break;
        const file = files[f]!;
        results.push({ path: file.rel, line: i + 1, text: file.lines[i]!.slice(0, 500) });
      }
    };

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (results.length >= this.maxGrepResults) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!this.skipDirs.has(entry.name)) await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue; // symlinks are not followed
        const rel = toPosixPath(path.relative(this.root, abs));
        if (matchGlob && !matchGlob(rel)) continue;
        // Never even scanned, so matches can't hint at their content.
        if (isProtectedPath(rel)) continue;
        if ((await stat(abs)).size > MAX_GREP_FILE_BYTES) continue;
        const buf = await readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) continue;
        const text = normalizeEol(buf.toString('utf8'));
        batch.push({ rel, lines: splitLines(text) });
        batchChars += text.length;
        if (batchChars >= GREP_BATCH_CHARS) await flush();
      }
    };
    try {
      await walk(this.root);
      await flush();
    } finally {
      void worker.terminate();
    }
    return results;
  }

  private matchInWorker(worker: Worker, texts: string[]): Promise<[number, number][]> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      const onMessage = (hits: [number, number][]) => {
        done();
        resolve(hits);
      };
      const onError = (err: Error) => {
        done();
        reject(err);
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            'The search pattern is too slow (it backtracks a lot). Use a simpler pattern, e.g. without nested repetition like (a+)+.',
          ),
        );
      }, this.grepTimeoutMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage(texts);
    });
  }

  /** Grep fallback: whole-word matches of the identifier at `line`/`col` (1-based). */
  async findReferences(
    relPath: string,
    line: number,
    col: number,
  ): Promise<{ path: string; line: number }[]> {
    const text = splitLines(await this.readFile(relPath))[line - 1] ?? '';
    const ident = identifierAt(text, col - 1);
    if (!ident) return [];
    const hits = await this.grep(`\\b${ident.replace(/\$/g, '\\$')}\\b`);
    return hits.map(({ path: p, line: l }) => ({ path: p, line: l }));
  }

  /** No language server outside VS Code (callers fall back to heuristics). Hosts may override. */
  async getSymbolAt(_relPath: string, _line: number): ReturnType<WorkspaceTools['getSymbolAt']> {
    return null;
  }
}

function identifierAt(text: string, index: number): string | undefined {
  const isWord = (c: string | undefined) => !!c && /[\w$]/.test(c);
  let start = index;
  let end = index;
  if (!isWord(text[index])) return undefined;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return text.slice(start, end);
}
