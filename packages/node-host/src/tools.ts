import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { normalizeEol, splitLines, toPosixPath, type WorkspaceTools } from '@ai-review/core';
import { resolveInRepo } from './sandbox';

export interface FsWorkspaceToolsOptions {
  /** Max characters returned by `readFile`. Default 100k. */
  maxReadChars?: number;
  /** Max grep matches. Default 200. */
  maxGrepResults?: number;
  /** Directory names never searched. */
  skipDirs?: string[];
}

const DEFAULT_SKIP = ['.git', 'node_modules', 'dist', 'out', 'build', '.vscode-test', 'coverage'];
const MAX_GREP_FILE_BYTES = 1024 * 1024;

/** Read-only file tools sandboxed to the repo root (no LSP: references fall back to grep). */
export class FsWorkspaceTools implements WorkspaceTools {
  readonly root: string;
  private readonly maxReadChars: number;
  private readonly maxGrepResults: number;
  private readonly skipDirs: Set<string>;

  constructor(root: string, options: FsWorkspaceToolsOptions = {}) {
    this.root = path.resolve(root);
    this.maxReadChars = options.maxReadChars ?? 100_000;
    this.maxGrepResults = options.maxGrepResults ?? 200;
    this.skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP);
  }

  async readFile(relPath: string, range?: { start: number; end: number }): Promise<string> {
    const abs = await resolveInRepo(this.root, relPath);
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
        if ((await stat(abs)).size > MAX_GREP_FILE_BYTES) continue;
        const buf = await readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) continue;
        const lines = splitLines(normalizeEol(buf.toString('utf8')));
        for (let i = 0; i < lines.length && results.length < this.maxGrepResults; i++) {
          if (regex.test(lines[i]!)) {
            results.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 500) });
          }
        }
      }
    };
    await walk(this.root);
    return results;
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

  /** No language server outside VS Code. */
  async getSymbolAt(): Promise<null> {
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
