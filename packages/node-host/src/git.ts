import { execFile } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
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
import { realRepoPath, resolveInRepo } from './sandbox';

/** The empty tree object: lets `git diff --cached` work before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_BUFFER = 256 * 1024 * 1024;
/** Working-tree and staged files larger than this are treated as binary, not reviewed. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Read errors that mean "this file can't be read" (locked, denied, too large), not a broken host. */
const UNREADABLE = new Set(['EACCES', 'EPERM', 'EBUSY', 'ERR_FS_FILE_TOO_LARGE']);

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
  (
    args: string[],
    options?: { allowFail?: boolean; maxBuffer?: number },
  ): Promise<{ stdout: string; code: number; overflow?: boolean }>;
}

export function createGitRunner(cwd: string, gitPath = 'git'): GitRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        gitPath,
        ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
        { cwd, maxBuffer: options.maxBuffer ?? MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          const overflow = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
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
          resolve({ stdout, code, overflow });
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
  /**
   * The text of an editor with unsaved changes to `absPath`, if any. File and selection
   * reviews use it in place of the file on disk, so they review what the user sees and
   * selected. The diff modes always read what git sees.
   */
  unsavedText?: (absPath: string) => string | undefined;
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
        // Untracked files are marked, so the host can decide whether to send them.
        const diff = await this.diff([]);
        await this.fillWorkingTree(diff.files);
        diff.files.push(...(await this.untracked()));
        return diff;
      }
      case 'staged': {
        const target = (await this.headCommit()) ?? EMPTY_TREE;
        const diff = await this.diff(['--cached', target]);
        // `:0:` names the stage, so a file called `1:foo` isn't read as stage 1 of `foo`.
        await this.fillFromGit(diff.files, (p) => `:0:${p}`);
        return diff;
      }
      case 'commits': {
        // As committed: the working tree and the index play no part.
        const newest = await this.commitId(mode.newest);
        const oldest = mode.oldest === mode.newest ? newest : await this.commitId(mode.oldest);
        if (oldest !== newest) {
          const { code } = await this.git(['merge-base', '--is-ancestor', oldest, newest], {
            allowFail: true,
          });
          if (code !== 0) {
            throw new DiffSourceError(
              'noCommit',
              `${mode.oldest} is not an earlier commit of ${mode.newest}, so there is no run of commits between them to review.`,
            );
          }
        }
        // The first commit has no parent: everything in it is new.
        const parent = await this.commitIdIfAny(`${oldest}^`);
        const diff = await this.diff([parent ?? EMPTY_TREE, newest]);
        await this.fillFromGit(diff.files, (p) => `${newest}:${p}`);
        return diff;
      }
      case 'branch': {
        // Tracked files only (committed, staged and unstaged changes): a stray untracked
        // file is not part of the branch.
        const base = await this.mergeBase(mode.base);
        const diff = await this.diff([base]);
        await this.fillWorkingTree(diff.files);
        return diff;
      }
      case 'file':
      case 'selection': {
        const rel = toPosixPath(mode.path);
        await this.refuseIgnored(rel);
        const content = await this.readWorkingFile(rel, { unsaved: true });
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

  /**
   * New-side content of the files from git objects (`spec` names the blob). Output past the
   * size cap stops git and marks the file binary, as for working files.
   */
  private async fillFromGit(files: FileDiff[], spec: (path: string) => string): Promise<void> {
    await mapLimit(files, 16, async (f) => {
      if (f.status === 'deleted' || f.binary) return;
      const { stdout, code, overflow } = await this.git(['show', spec(f.path)], {
        allowFail: true,
        maxBuffer: MAX_FILE_BYTES,
      });
      if (overflow) f.binary = true;
      else if (code === 0) f.newContent = normalizeEol(stdout);
    });
  }

  /** Full id of the commit `ref` names, or throws `noCommit`. */
  private async commitId(ref: string): Promise<string> {
    if (!isSafeRef(ref)) {
      throw new DiffSourceError('noCommit', `"${ref}" is not a valid commit.`);
    }
    const id = await this.commitIdIfAny(ref);
    if (!id) throw new DiffSourceError('noCommit', `Commit "${ref}" was not found.`);
    return id;
  }

  private async commitIdIfAny(ref: string): Promise<string | undefined> {
    const { stdout, code } = await this.git(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      {
        allowFail: true,
      },
    );
    return code === 0 && stdout.trim() ? stdout.trim() : undefined;
  }

  private headCommit(): Promise<string | undefined> {
    return this.commitIdIfAny('HEAD');
  }

  private async refExists(ref: string): Promise<boolean> {
    return (await this.commitIdIfAny(ref)) !== undefined;
  }

  /** Untracked files that aren't ignored, as added files marked `untracked`. */
  private async untracked(): Promise<FileDiff[]> {
    const { stdout } = await this.git(['ls-files', '--others', '--exclude-standard', '-z']);
    const paths = stdout.split('\0').filter(Boolean).map(toPosixPath);
    const files = await mapLimit(paths, 16, async (p): Promise<FileDiff | undefined> => {
      const content = await this.readWorkingFile(p, { inDiff: true });
      if (content === undefined) return undefined;
      return { ...addedFileDiff(p, content), untracked: true };
    });
    return files.filter((f): f is FileDiff => f !== undefined);
  }

  /**
   * Throws `ignored` when git ignores `rel` (and doesn't track it): a local config or other
   * file kept out of the repository is never sent. Checks where the file really is, after
   * symlinks, so a tracked link to an ignored file is refused too. When git can't tell, the
   * file is refused as well.
   */
  private async refuseIgnored(rel: string): Promise<void> {
    const abs = await resolveInRepo(this.root, rel);
    // A file that isn't on disk (only in an editor) is checked by its name.
    const real = await realRepoPath(this.root, abs).catch(() => rel);
    // Tracked files are never "ignored" here, even when they match an ignore pattern. The
    // `./` keeps a name starting with `:` from being read as pathspec magic.
    const { code } = await this.git(['check-ignore', '--quiet', '--', `./${real}`], {
      allowFail: true,
    });
    if (code === 0) {
      throw new DiffSourceError('ignored', `${rel} is ignored by git, so it isn't reviewed.`);
    }
    if (code !== 1) {
      throw new DiffSourceError(
        'git',
        `Could not check whether ${rel} is ignored by git, so it isn't reviewed.`,
      );
    }
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
   * `unsaved`: an editor's unsaved text wins over the file (same size cap and binary check).
   */
  private async readWorkingFile(
    rel: string,
    options: { inDiff?: boolean; unsaved?: boolean } = {},
  ): Promise<string | undefined> {
    try {
      const abs = await resolveInRepo(this.root, rel);
      const unsaved = options.unsaved ? this.options.unsavedText?.(abs) : undefined;
      if (unsaved !== undefined) this.logger.info(`${rel}: reviewing the unsaved editor text`);
      if (unsaved === undefined) {
        const info = await (options.inDiff ? lstat : stat)(abs);
        if (info.isSymbolicLink()) return undefined;
        if (info.size > MAX_FILE_BYTES) return '\0';
      }
      const buf = unsaved !== undefined ? Buffer.from(unsaved, 'utf8') : await readFile(abs);
      if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) return '\0';
      return normalizeEol(buf.toString('utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return undefined;
      if ((err as { kind?: string }).kind === 'outsideRepo') {
        if (options.inDiff) return undefined;
        throw err;
      }
      if (options.inDiff && code !== undefined && UNREADABLE.has(code)) {
        this.logger.warn(`${rel}: skipped, the file could not be read (${code})`);
        return undefined;
      }
      throw err;
    }
  }
}

export interface CommitInfo {
  /** Full commit id. */
  id: string;
  shortId: string;
  subject: string;
  author: string;
  /** Commit date, ISO 8601. */
  date: string;
}

/** Separators in the `git log` output (`%x1f`, `%x1e`): not in subjects or names. */
const FIELD = '\x1f';
const RECORD = '\x1e';

/**
 * The latest `limit` commits of HEAD, newest first, following first parents only: each
 * commit's parent is the next one, so a run of them is exactly what a `commits` review of
 * its oldest and newest reviews. Empty before the first commit.
 */
export async function listCommits(
  root: string,
  options: { gitPath?: string; limit?: number } = {},
): Promise<CommitInfo[]> {
  const git = createGitRunner(root, options.gitPath);
  const { stdout, code } = await git(
    [
      'log',
      '--first-parent',
      `--max-count=${options.limit ?? 100}`,
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e',
      'HEAD',
      '--',
    ],
    { allowFail: true },
  );
  if (code !== 0) return [];
  return stdout
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [id = '', shortId = '', subject = '', author = '', date = ''] = r.split(FIELD);
      return { id, shortId, subject, author, date };
    });
}

/**
 * The run of `commits` (newest first, as `listCommits` gives them) from the oldest to the
 * newest of `picked`: what a `commits` review of them covers. `unpicked` counts the commits
 * in between that weren't picked (they are reviewed too). Undefined when none is in the list.
 */
export function commitSpan(
  commits: readonly CommitInfo[],
  picked: readonly string[],
): { oldest: string; newest: string; count: number; unpicked: number } | undefined {
  const wanted = new Set(picked);
  const at = commits.flatMap((c, i) => (wanted.has(c.id) ? [i] : []));
  if (!at.length) return undefined;
  const first = at[0]!;
  const last = at[at.length - 1]!;
  const count = last - first + 1;
  return {
    newest: commits[first]!.id,
    oldest: commits[last]!.id,
    count,
    unpicked: count - at.length,
  };
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
