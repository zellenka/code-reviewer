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

/** Read-only, sandboxed to the repo root. Implemented per host. */
export interface WorkspaceTools {
  readFile(path: string, range?: { start: number; end: number }): Promise<string>;
  grep(pattern: string, glob?: string): Promise<{ path: string; line: number; text: string }[]>;
  findReferences(
    path: string,
    line: number,
    col: number,
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
