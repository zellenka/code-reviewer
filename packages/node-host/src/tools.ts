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
import { createGitRunner } from './git';
import { pathKey, realRepoPath, resolveInRepo } from './sandbox';

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

/** Files git shows (keys from `pathKey`), and the directories that hold them. */
interface GitFiles {
  files: Set<string>;
  dirs: Set<string>;
}

/**
 * Read-only file tools sandboxed to the repo root (no LSP: references fall back to grep).
 * They show only the files git shows: tracked ones, and untracked ones that aren't ignored,
 * as the diff modes do. Ignored files (`.aws/credentials`, `*.tfvars`, …) often hold
 * secrets the protected-path list doesn't name. The list is read once per instance (one
 * review). If git can't list the files (not a repo, git missing), nothing is read.
 */
export class FsWorkspaceTools implements WorkspaceTools {
  readonly root: string;
  private readonly maxReadChars: number;
  private readonly maxGrepResults: number;
  private readonly skipDirs: Set<string>;
  private readonly grepTimeoutMs: number;
  private readonly gitPath: string | undefined;
  private gitFiles?: Promise<GitFiles>;

  constructor(root: string, options: FsWorkspaceToolsOptions = {}) {
    this.root = path.resolve(root);
    this.maxReadChars = options.maxReadChars ?? 100_000;
    this.maxGrepResults = options.maxGrepResults ?? 200;
    this.skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP);
    this.grepTimeoutMs = options.grepTimeoutMs ?? 3_000;
    this.gitPath = options.gitPath;
  }

  async readFile(relPath: string, range?: { start: number; end: number }): Promise<string> {
    const abs = await this.resolveReadable(relPath);
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

  /**
   * Absolute path of a file the tools may open: inside the repo, shown by git, not a
   * secret file. Hosts that open files another way (e.g. a language server) call this first.
   */
  protected async resolveReadable(relPath: string): Promise<string> {
    const abs = await resolveInRepo(this.root, relPath);
    const { files } = await this.listGitFiles();
    const notShown = () => new Error(`${relPath} can't be read: it is ignored by git or missing.`);
    // Checked by name before the file is looked up, so the answer doesn't tell whether an
    // ignored file exists. A path under a listed symlink (git lists the link) is checked by
    // its target.
    const rel = toPosixPath(path.relative(this.root, abs));
    const viaLink = !files.has(pathKey(rel));
    if (viaLink && !ancestors(rel).some((dir) => files.has(pathKey(dir)))) throw notShown();
    let real: string;
    try {
      real = await realRepoPath(this.root, abs);
    } catch (err) {
      if (viaLink) throw notShown();
      throw err;
    }
    // Callers check the name they ask for; this checks what a symlink points to.
    if (isProtectedPath(real)) {
      throw new Error(`${relPath} can't be read: it may contain secrets.`);
    }
    if (!files.has(pathKey(real))) throw notShown();
    return abs;
  }

  /** Whether git shows `rel` (repo-relative, `/`). Hosts filter paths from other sources with it. */
  protected async isListed(rel: string): Promise<boolean> {
    return (await this.listGitFiles()).files.has(pathKey(toPosixPath(rel)));
  }

  /** `git ls-files`, once per instance: a file created during the review is not shown. */
  private listGitFiles(): Promise<GitFiles> {
    this.gitFiles ??= gitFileList(this.root, this.gitPath);
    return this.gitFiles;
  }

  async grep(
    pattern: string,
    glob?: string,
  ): Promise<{ path: string; line: number; text: string }[]> {
    const { files: listed, dirs } = await this.listGitFiles();
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
        const rel = toPosixPath(path.relative(this.root, abs));
        if (entry.isDirectory()) {
          // A directory with no file git shows (ignored, a nested repo) isn't entered.
          if (!this.skipDirs.has(entry.name) && dirs.has(pathKey(rel))) await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue; // symlinks are not followed
        if (!listed.has(pathKey(rel))) continue;
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

/**
 * Tracked files plus untracked ones that aren't ignored (.gitignore at any depth,
 * .git/info/exclude, the user's excludes file). Submodules and nested repos are listed as
 * one entry, so their files aren't shown. Fails with a message that hides git's output.
 */
async function gitFileList(root: string, gitPath?: string): Promise<GitFiles> {
  const git = createGitRunner(root, gitPath);
  let stdout: string;
  try {
    ({ stdout } = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  } catch (err) {
    throw new Error("Files can't be read: git could not list the repository's files.", {
      cause: err,
    });
  }
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const p of stdout.split('\0')) {
    // `nested/` is an untracked repository inside this one.
    if (!p || p.endsWith('/')) continue;
    const key = pathKey(p);
    files.add(key);
    for (const dir of ancestors(key)) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }
  return { files, dirs };
}

/** `a/b/c` → `a/b`, `a`. */
function ancestors(rel: string): string[] {
  const out: string[] = [];
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
    out.push(rel.slice(0, i));
  }
  return out;
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
