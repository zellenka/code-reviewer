import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DiffSourceError,
  addedFileDiff,
  noopLogger,
  normalizeEol,
  parseUnifiedDiff,
  toPosixPath,
  type DiffSource,
  type FileDiff,
  type Logger,
  type ReviewMode,
  type UnifiedDiff,
} from '@ai-review/core';
import { resolveInRepo } from './sandbox';

/** The empty tree object: lets `git diff --cached` work before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_BUFFER = 256 * 1024 * 1024;
/** Untracked/working-tree files larger than this are not read (treated as binary). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
];

export interface GitRunner {
  (args: string[], options?: { allowFail?: boolean }): Promise<{ stdout: string; code: number }>;
}

export function createGitRunner(cwd: string, gitPath = 'git'): GitRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        gitPath,
        ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
        { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          if (error && !options.allowFail) {
            const detail = stderr.trim() || error.message;
            reject(
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? new DiffSourceError('git', `Git was not found (${gitPath}). Install git.`, {
                    cause: error,
                  })
                : new DiffSourceError('git', `git ${args[0]} failed: ${detail}`, { cause: error }),
            );
            return;
          }
          resolve({ stdout, code });
        },
      );
    });
}

/** Repo root (absolute OS path) containing `cwd`, or throws `noRepo`. */
export async function findRepoRoot(cwd: string, gitPath?: string): Promise<string> {
  const git = createGitRunner(cwd, gitPath);
  const { stdout, code } = await git(['rev-parse', '--show-toplevel'], { allowFail: true });
  if (code !== 0 || !stdout.trim()) {
    throw new DiffSourceError('noRepo', `No git repository found at ${cwd}.`);
  }
  return path.resolve(stdout.trim());
}

export interface GitCliDiffSourceOptions {
  /** Repo root (absolute path). */
  root: string;
  gitPath?: string;
  /** Base for `branch` mode when the mode doesn't name one. Default: auto-detect. */
  defaultBase?: string | (() => string | undefined);
  logger?: Logger;
}

/** `DiffSource` backed by the git CLI. Used by evals, the CLI and the VS Code extension. */
export class GitCliDiffSource implements DiffSource {
  readonly root: string;
  private readonly git: GitRunner;
  private readonly logger: Logger;

  constructor(private readonly options: GitCliDiffSourceOptions) {
    this.root = path.resolve(options.root);
    this.git = createGitRunner(this.root, options.gitPath);
    this.logger = options.logger ?? noopLogger;
  }

  async getDiff(mode: ReviewMode): Promise<UnifiedDiff> {
    switch (mode.kind) {
      case 'unstaged': {
        const diff = await this.diff([]);
        await this.fillWorkingTree(diff.files);
        diff.files.push(...(await this.untracked()));
        return diff;
      }
      case 'staged': {
        const target = (await this.headCommit()) ?? EMPTY_TREE;
        const diff = await this.diff(['--cached', target]);
        await Promise.all(
          diff.files.map(async (f) => {
            if (f.status === 'deleted' || f.binary) return;
            const { stdout, code } = await this.git(['show', `:${f.path}`], { allowFail: true });
            if (code === 0) f.newContent = normalizeEol(stdout);
          }),
        );
        return diff;
      }
      case 'branch': {
        const base = await this.mergeBase(mode.base);
        const diff = await this.diff([base]);
        await this.fillWorkingTree(diff.files);
        diff.files.push(...(await this.untracked()));
        return diff;
      }
      case 'file':
      case 'selection': {
        const rel = toPosixPath(mode.path);
        const content = await this.readWorkingFile(rel);
        if (content === undefined) throw new DiffSourceError('notFound', `File not found: ${rel}`);
        const range =
          mode.kind === 'selection' ? { startLine: mode.startLine, endLine: mode.endLine } : {};
        return { files: [addedFileDiff(rel, content, { ...range, status: 'modified' })] };
      }
    }
  }

  /** Base ref used by `branch` mode: explicit → setting → origin/HEAD → main → master. */
  async detectBase(explicit?: string): Promise<string> {
    const configured =
      explicit ??
      (typeof this.options.defaultBase === 'function'
        ? this.options.defaultBase()
        : this.options.defaultBase);
    if (configured) {
      if (!isSafeRef(configured)) {
        throw new DiffSourceError('noBase', `"${configured}" is not a valid branch name.`);
      }
      if (await this.refExists(configured)) return configured;
      throw new DiffSourceError('noBase', `Base branch "${configured}" was not found.`);
    }
    const originHead = await this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      allowFail: true,
    });
    if (originHead.code === 0 && originHead.stdout.trim()) {
      return originHead.stdout.trim().replace(/^refs\/remotes\//, '');
    }
    for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
      if (await this.refExists(candidate)) return candidate;
    }
    throw new DiffSourceError(
      'noBase',
      'Could not find a base branch (tried origin/HEAD, main, master). Set one in the settings.',
    );
  }

  private async mergeBase(explicit?: string): Promise<string> {
    if (!(await this.headCommit())) {
      throw new DiffSourceError('noBase', 'This repository has no commits yet.');
    }
    const branch = await this.git(['symbolic-ref', '--quiet', 'HEAD'], { allowFail: true });
    if (branch.code !== 0) {
      throw new DiffSourceError(
        'detachedHead',
        'HEAD is detached. Check out a branch to review branch changes, or review staged/unstaged changes.',
      );
    }
    const base = await this.detectBase(explicit);
    const { stdout, code } = await this.git(['merge-base', base, 'HEAD'], { allowFail: true });
    if (code !== 0 || !stdout.trim()) {
      throw new DiffSourceError('noBase', `"${base}" and HEAD have no common history.`);
    }
    this.logger.debug(`branch review: base ${base} (merge-base ${stdout.trim().slice(0, 8)})`);
    return stdout.trim();
  }

  private async diff(args: string[]): Promise<UnifiedDiff> {
    const { stdout } = await this.git(['diff', ...DIFF_FLAGS, ...args]);
    return parseUnifiedDiff(stdout);
  }

  private async headCommit(): Promise<string | undefined> {
    const { stdout, code } = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      allowFail: true,
    });
    return code === 0 ? stdout.trim() : undefined;
  }

  private async refExists(ref: string): Promise<boolean> {
    const { code } = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      allowFail: true,
    });
    return code === 0;
  }

  private async untracked(): Promise<FileDiff[]> {
    const { stdout } = await this.git(['ls-files', '--others', '--exclude-standard', '-z']);
    const paths = stdout.split('\0').filter(Boolean).map(toPosixPath);
    const files = await mapLimit(paths, 16, async (p) => {
      const content = await this.readWorkingFile(p, { inDiff: true });
      if (content === undefined) return undefined;
      return addedFileDiff(p, content);
    });
    return files.filter((f): f is FileDiff => f !== undefined);
  }

  private async fillWorkingTree(files: FileDiff[]): Promise<void> {
    await mapLimit(files, 16, async (f) => {
      if (f.status === 'deleted' || f.binary) return;
      const content = await this.readWorkingFile(f.path, { inDiff: true });
      if (content === undefined) return;
      if (content.includes('\0')) f.binary = true;
      else f.newContent = content;
    });
  }

  /**
   * Normalized working-tree content; `\0` marks binary/oversized; undefined if missing.
   * `inDiff`: the path came from git, so symlinks aren't followed (git already shows the
   * link target as the content) and unreadable paths are skipped instead of failing the review.
   */
  private async readWorkingFile(
    rel: string,
    options: { inDiff?: boolean } = {},
  ): Promise<string | undefined> {
    try {
      const abs = await resolveInRepo(this.root, rel);
      if (options.inDiff && (await lstat(abs)).isSymbolicLink()) return undefined;
      const buf = await readFile(abs);
      if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) return '\0';
      return normalizeEol(buf.toString('utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return undefined;
      if ((err as { kind?: string }).kind === 'outsideRepo') {
        if (options.inDiff) return undefined;
        throw err;
      }
      throw err;
    }
  }
}

/** Ref names passed to git: no option-like (`-x`), whitespace or `..` range values. */
export function isSafeRef(ref: string): boolean {
  return /^[\w./@{}^~-]+$/.test(ref) && !ref.startsWith('-') && !ref.includes('..');
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
