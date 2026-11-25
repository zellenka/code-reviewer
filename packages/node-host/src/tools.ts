import { lstat, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { compareRepoPaths, normalizeEol, splitLines, type WorkspaceTools } from '@ai-review/core';
import { createGitRunner } from './git';
import { caseInsensitive, isInside, realRepoPath, resolveInRepo } from './sandbox';

export interface FsWorkspaceToolsOptions {
  /** Git executable that lists the repository's files. Default `git`. */
  gitPath?: string;
  /** Max characters returned by `readFile`. Default 100k. */
  maxReadChars?: number;
  /** Max grep matches. Default 200. */
  maxGrepResults?: number;
  /** Directory names never searched. */
  skipDirs?: string[];
  /** A grep whose regex takes longer than this on one batch of files fails. Default 3s. */
  grepTimeoutMs?: number;
  /**
   * Also show untracked files that aren't ignored. Default true; false when the review
   * leaves untracked files out, so the model can't read them either.
   */
  untracked?: boolean;
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
/**
 * Larger files are refused unread (tools redact the whole file before cutting it). Same as
 * the size above which the diff modes treat a file as binary (`MAX_FILE_BYTES` in git.ts);
 * above `MAX_GREP_FILE_BYTES`, so every grep hit can still be checked against its file.
 */
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;
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

/**
 * Raw, read-only file access sandboxed to the repo root: no absolute paths, `..` steps or
 * symlinks out of it (no LSP: references fall back to grep). What the model may see (secret
 * and git-ignored files, redaction, error text) is checked in core, around every host.
 * `listFiles` asks git once per instance (one review), as the diff modes see the repo.
 */
export class FsWorkspaceTools implements WorkspaceTools {
  readonly root: string;
  readonly caseInsensitive = caseInsensitive;
  private readonly maxReadChars: number;
  private readonly maxGrepResults: number;
  private readonly skipDirs: Set<string>;
  private readonly grepTimeoutMs: number;
  private readonly gitPath: string | undefined;
  private readonly untracked: boolean;
  private gitFiles?: Promise<string[]>;

  constructor(root: string, options: FsWorkspaceToolsOptions = {}) {
    this.root = path.resolve(root);
    this.untracked = options.untracked ?? true;
    this.maxReadChars = options.maxReadChars ?? 100_000;
    this.maxGrepResults = options.maxGrepResults ?? 200;
    this.skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP);
    this.grepTimeoutMs = options.grepTimeoutMs ?? 3_000;
    this.gitPath = options.gitPath;
  }

  /** A file over `MAX_READ_FILE_BYTES` is refused unread, also for a range (read whole). */
  async readFile(
    relPath: string,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const abs = await resolveInRepo(this.root, relPath);
    const tooLarge = () =>
      new Error(`${relPath} is too large to read (over ${MAX_READ_FILE_BYTES / 1024 / 1024} MB).`);
    if ((await stat(abs)).size > MAX_READ_FILE_BYTES) throw tooLarge();
    const buf = await readFile(abs, { signal });
    // It may have grown since `stat`.
    if (buf.length > MAX_READ_FILE_BYTES) throw tooLarge();
    let text = normalizeEol(buf.toString('utf8'));
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

  /** `git ls-files`, once per instance: a file created during the review is not shown. */
  listFiles(signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    this.gitFiles ??= gitFileList(this.root, this.gitPath, this.untracked);
    return this.gitFiles;
  }

  async realPath(relPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return realRepoPath(this.root, await resolveInRepo(this.root, relPath));
  }

  /**
   * Reads the given files in order, skipping dependency and build directories, symlinks,
   * large and binary files. A `signal` stops the reads and the regex worker.
   */
  async grep(
    pattern: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ path: string; line: number; text: string }[]> {
    signal?.throwIfAborted();
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
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
      signal?.throwIfAborted();
      const hits = await this.matchInWorker(
        worker,
        files.map((f) => f.lines.join('\n')),
        signal,
      );
      for (const [f, i] of hits) {
        if (results.length >= this.maxGrepResults) break;
        const file = files[f]!;
        results.push({ path: file.rel, line: i + 1, text: file.lines[i]!.slice(0, 500) });
      }
    };

    // Git lists files under a symlinked directory (a junction) by the link's name.
    const realDirs = new Map<string, Promise<boolean>>();
    const isRealDir = (dir: string): Promise<boolean> => {
      if (!dir) return Promise.resolve(true);
      let known = realDirs.get(dir);
      if (!known) {
        const parent = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
        known = isRealDir(parent).then(
          async (ok) =>
            ok && !!(await lstat(path.join(this.root, dir)).catch(() => undefined))?.isDirectory(),
        );
        realDirs.set(dir, known);
      }
      return known;
    };

    const search = async (): Promise<void> => {
      for (const rel of paths) {
        if (results.length >= this.maxGrepResults) return;
        signal?.throwIfAborted();
        const parts = rel.split('/');
        if (parts.slice(0, -1).some((dir) => this.skipDirs.has(dir))) continue;
        const abs = path.resolve(this.root, ...parts);
        if (!isInside(this.root, abs)) continue;
        // Symlinks are not followed; a file deleted since it was listed is skipped.
        if (!(await isRealDir(parts.slice(0, -1).join('/')))) continue;
        const info = await lstat(abs).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_GREP_FILE_BYTES) continue;
        const buf = await readFile(abs, { signal });
        if (buf.subarray(0, 8000).includes(0)) continue;
        const text = normalizeEol(buf.toString('utf8'));
        batch.push({ rel, lines: splitLines(text) });
        batchChars += text.length;
        if (batchChars >= GREP_BATCH_CHARS) await flush();
      }
    };
    try {
      await search();
      await flush();
    } finally {
      void worker.terminate();
    }
    return results;
  }

  private matchInWorker(
    worker: Worker,
    texts: string[],
    signal?: AbortSignal,
  ): Promise<[number, number][]> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      // The caller terminates the worker, which may be stuck in a slow regex.
      const onAbort = () => {
        done();
        reject(signal!.reason);
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
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(texts);
    });
  }

  /**
   * Grep fallback: whole-word matches of the identifier at `line`/`col` (1-based) in the
   * listed files (core leaves out the ones the model may not see).
   */
  async findReferences(
    relPath: string,
    line: number,
    col: number,
    signal?: AbortSignal,
  ): Promise<{ path: string; line: number }[]> {
    const text = splitLines(await this.readFile(relPath, undefined, signal))[line - 1] ?? '';
    const ident = identifierAt(text, col - 1);
    if (!ident) return [];
    const pattern = `\\b${ident.replace(/\$/g, '\\$')}\\b`;
    const paths = [...(await this.listFiles(signal))].sort(compareRepoPaths);
    const hits = await this.grep(pattern, paths, signal);
    return hits.map(({ path: p, line: l }) => ({ path: p, line: l }));
  }

  /** No language server outside VS Code (callers fall back to heuristics). Hosts may override. */
  async getSymbolAt(_relPath: string, _line: number): ReturnType<WorkspaceTools['getSymbolAt']> {
    return null;
  }
}

/**
 * Tracked files plus (with `untracked`) untracked ones that aren't ignored (.gitignore at
 * any depth, .git/info/exclude, the user's excludes file). Submodules and nested repos are
 * listed as one entry, so their files aren't shown. Fails with a message that hides git's
 * output.
 */
async function gitFileList(
  root: string,
  gitPath: string | undefined,
  untracked: boolean,
): Promise<string[]> {
  const git = createGitRunner(root, gitPath);
  let stdout: string;
  try {
    ({ stdout } = await git([
      'ls-files',
      '-z',
      '--cached',
      ...(untracked ? ['--others', '--exclude-standard'] : []),
    ]));
  } catch (err) {
    throw new Error("Files can't be read: git could not list the repository's files.", {
      cause: err,
    });
  }
  // `nested/` is an untracked repository inside this one.
  return [...new Set(stdout.split('\0').filter((p) => p && !p.endsWith('/')))];
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
