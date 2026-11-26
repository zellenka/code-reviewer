/**
 * Diff model. Lines are 1-based and inclusive; paths are repo-relative POSIX;
 * text is `\n`-normalized (see Conventions in implementation-plan.md).
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  /** Has unresolved merge conflicts (git showed a combined diff or "Unmerged path"); no hunks. */
  unmerged?: boolean;
  hunks: Hunk[];
  /** Full new-side content (for context and re-anchoring). */
  newContent?: string;
  /**
   * Not tracked by git (a new file that isn't ignored), in an `unstaged` diff. The host
   * decides whether to send it (the VS Code extension asks first).
   */
  untracked?: boolean;
}

export interface UnifiedDiff {
  files: FileDiff[];
}

export type ReviewMode =
  /** Working tree vs index, plus untracked files that aren't ignored (`FileDiff.untracked`). */
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  /** Diff from merge-base(base, HEAD) to the working tree: tracked files only, no untracked ones. */
  | { kind: 'branch'; base?: string }
  /** A file git doesn't ignore (tracked, or untracked and not ignored), as on disk or in the editor. */
  | { kind: 'file'; path: string }
  | { kind: 'selection'; path: string; startLine: number; endLine: number }
  /**
   * What a run of commits changed, as committed: from the first parent of `oldest` (nothing,
   * for the first commit) to `newest`. One commit: `oldest` and `newest` are the same.
   */
  | { kind: 'commits'; oldest: string; newest: string };

/** Implemented per host; core only parses. */
export interface DiffSource {
  getDiff(mode: ReviewMode): Promise<UnifiedDiff>;
}

/**
 * Raw, read-only access to the repo. Implemented per host, which does IO only and keeps every
 * path inside the repo root (no absolute paths, `..` steps or symlinks out of it). What the
 * model may see is decided in core (`guardWorkspace`, applied by `createReviewTools`): secret
 * files, files git doesn't show, redaction and error text. Paths are repo-relative with `/`.
 * A call given a `signal` stops early (rejects with its abort reason) when the review is
 * cancelled.
 */
export interface WorkspaceTools {
  /**
   * Absolute path of the repo root, if the host has one. Agent tools remove it (in any
   * spelling) from error messages before the model sees them.
   */
  readonly root?: string;
  /** File names that differ only in letter case name the same file (Windows, macOS). */
  readonly caseInsensitive?: boolean;
  /**
   * The files git shows: tracked ones, and untracked ones that aren't ignored (unless the
   * review leaves untracked files out). Rejects when
   * they can't be listed (not a repo, git missing); then nothing is read.
   */
  listFiles(signal?: AbortSignal): Promise<string[]>;
  /**
   * Where an existing file or directory really is, after symlinks (`docs/notes.md` → `.env`
   * for a link to it). Rejects paths outside the repo, and with `ENOENT` missing ones.
   */
  realPath(path: string, signal?: AbortSignal): Promise<string>;
  readFile(
    path: string,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Matching lines in `paths` (files from `listFiles`), in that order. Files it can't search
   * (binary, very large, symlinks) may be skipped.
   */
  grep(
    pattern: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ path: string; line: number; text: string }[]>;
  findReferences(
    path: string,
    line: number,
    col: number,
    signal?: AbortSignal,
  ): Promise<{ path: string; line: number }[]>;
  getSymbolAt(
    path: string,
    line: number,
  ): Promise<{ name: string; kind: string; startLine: number; endLine: number } | null>;
}

export function describeMode(mode: ReviewMode): string {
  switch (mode.kind) {
    case 'unstaged':
      return 'unstaged changes';
    case 'staged':
      return 'staged changes';
    case 'branch':
      return mode.base ? `changes since ${mode.base}` : 'branch changes';
    case 'file':
      return mode.path;
    case 'selection':
      return `${mode.path}:${mode.startLine}-${mode.endLine}`;
    case 'commits':
      return mode.oldest === mode.newest
        ? `commit ${shortRef(mode.newest)}`
        : `commits ${shortRef(mode.oldest)} to ${shortRef(mode.newest)}`;
  }
}

/** A full commit id shortened to 7 characters; any other ref as it is. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
