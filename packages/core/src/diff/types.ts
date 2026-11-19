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
}

export interface UnifiedDiff {
  files: FileDiff[];
}

export type ReviewMode =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  /** Diff from merge-base(base, HEAD) to the working tree. */
  | { kind: 'branch'; base?: string }
  | { kind: 'file'; path: string }
  | { kind: 'selection'; path: string; startLine: number; endLine: number };

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
   * The files git shows: tracked ones, and untracked ones that aren't ignored. Rejects when
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
  }
}
