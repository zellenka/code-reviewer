import type { FileDiff } from '../diff/types';
import { noopLogger, type Logger } from '../logger';

/** A declaration in a file. Lines are 1-based and inclusive (new side). */
export interface CodeSymbol {
  name: string;
  /** 'class', 'function', 'method', … (free-form; LSP kinds are mapped to lower-case names). */
  kind: string;
  startLine: number;
  endLine: number;
  children?: CodeSymbol[];
}

/**
 * Host-provided symbols (VS Code: the language server's document symbols).
 * `content` is the new-side text the review sees; return undefined when the host's view
 * of the file differs from it (e.g. staged content ≠ working tree) or nothing is known.
 */
export interface SymbolProvider {
  documentSymbols(path: string, content: string): Promise<CodeSymbol[] | undefined>;
}

/** Symbols per repo-relative path. Paths missing here fall back to `heuristicSymbols`. */
export type SymbolIndex = ReadonlyMap<string, readonly CodeSymbol[]>;

export interface LoadSymbolsOptions {
  /** Per-file timeout. Language servers can be slow to start. Default 3s. */
  timeoutMs?: number;
  /** At most this many files are asked. Default 50. */
  maxFiles?: number;
  logger?: Logger;
}

/** Asks the host for the symbols of each file with content. Failures and timeouts are skipped. */
export async function loadSymbols(
  files: readonly FileDiff[],
  provider: SymbolProvider,
  options: LoadSymbolsOptions = {},
): Promise<SymbolIndex> {
  const logger = options.logger ?? noopLogger;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const index = new Map<string, CodeSymbol[]>();
  const targets = files.filter((f) => f.newContent !== undefined && f.status !== 'deleted');
  await Promise.all(
    targets.slice(0, options.maxFiles ?? 50).map(async (file) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const symbols = await Promise.race([
          provider.documentSymbols(file.path, file.newContent!),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeoutMs);
          }),
        ]);
        if (symbols?.length) index.set(file.path, symbols);
      } catch (err) {
        logger.debug(`symbols for ${file.path} unavailable: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  logger.debug(`language-server symbols for ${index.size}/${targets.length} file(s)`);
  return index;
}

/** Innermost-last chain of symbols that contain `line`. */
export function enclosingSymbols(symbols: readonly CodeSymbol[], line: number): CodeSymbol[] {
  const chain: CodeSymbol[] = [];
  let level: readonly CodeSymbol[] | undefined = symbols;
  while (level?.length) {
    // The smallest match wins when siblings overlap (e.g. an overload list).
    const hit: CodeSymbol | undefined = level
      .filter((s) => s.startLine <= line && line <= s.endLine)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
    if (!hit) break;
    chain.push(hit);
    level = hit.children;
  }
  return chain;
}

const CLASS_RE =
  /^(?:export\s+)?(?:default\s+)?(?:pub(?:\([\w:]+\))?\s+)?(?:public\s+|private\s+|protected\s+|internal\s+)?(?:abstract\s+|sealed\s+|final\s+|static\s+|partial\s+|declare\s+|data\s+)*(class|interface|enum|namespace|module|struct|trait|impl|object|record)\s+([\w$.]+)?/;
const GO_TYPE_RE = /^type\s+(\w+)\s+(struct|interface)\b/;
const FUNCTION_RE =
  /^(?:export\s+)?(?:default\s+)?(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:function\*?|def|fn|func|fun)\s*(?:\([^)]*\)\s*)?([\w$]+)?/;
const ARROW_RE =
  /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)?|[\w$]+)\s*(?::[^=]+)?(?:=>|$))/;
const METHOD_RE =
  /^(?:(?:public|private|protected|internal|static|readonly|async|override|abstract|virtual|final|synchronized|get|set)\s+)*(?:[\w$<>[\],.?]+\s+)?([\w$]+)\s*(?:<[^>]*>)?\s*\(/;
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'else',
  'do',
  'try',
  'with',
  'await',
  'new',
  'throw',
  'yield',
  'typeof',
  'delete',
  'void',
  'case',
  'elif',
  'except',
  'super',
  'this',
  'foreach',
  'using',
  'lock',
  'match',
  'select',
]);

/** Above this many lines the heuristic isn't run (cost; such files are rarely hand-written). */
const MAX_HEURISTIC_LINES = 20_000;

/**
 * Language-agnostic declaration finder used when no language server is available
 * (CLI, evals) or it returned nothing. Looks for declaration-like lines (class, function,
 * method, arrow function) and takes the indented block below each one as its body.
 * Good enough for well-formatted code in C-like languages and Python; wrong guesses only
 * cost a few context lines.
 */
export function heuristicSymbols(content: string): CodeSymbol[] {
  const lines = content.split('\n');
  if (lines.length > MAX_HEURISTIC_LINES) return [];
  const flat: CodeSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const decl = declarationAt(lines[i]!);
    if (!decl) continue;
    const end = blockEnd(lines, i);
    if (end === undefined) continue;
    flat.push({ ...decl, startLine: i + 1, endLine: end + 1 });
  }
  return nest(flat);
}

function declarationAt(raw: string): { name: string; kind: string } | undefined {
  const line = raw.trim();
  if (!line || /^(\/\/|#|\*|\/\*|--)/.test(line) || line.startsWith('@')) return undefined;
  let m = CLASS_RE.exec(line);
  if (m) return { kind: classKind(m[1]!), name: m[2] ?? '(anonymous)' };
  m = GO_TYPE_RE.exec(line);
  if (m) return { kind: m[2] === 'struct' ? 'struct' : 'interface', name: m[1]! };
  m = FUNCTION_RE.exec(line);
  if (
    m &&
    /^(?:export\s+|default\s+|pub\S*\s+|async\s+|unsafe\s+)*(function|def|fn|func|fun)\b/.test(line)
  ) {
    return { kind: 'function', name: m[1] ?? '(anonymous)' };
  }
  m = ARROW_RE.exec(line);
  if (m && (line.includes('=>') || /=\s*(?:async\s+)?function\b/.test(line))) {
    return { kind: 'function', name: m[1]! };
  }
  // Methods: `name(…) {` with no `=>` (callbacks) and no `;` (calls), not a keyword.
  m = METHOD_RE.exec(line);
  if (
    m &&
    !line.includes('=>') &&
    !line.includes(';') &&
    !line.includes('=') &&
    /[{(,:]$/.test(line)
  ) {
    const first = line.split(/[\s(]/, 1)[0]!;
    if (!KEYWORDS.has(m[1]!) && !KEYWORDS.has(first)) return { kind: 'method', name: m[1]! };
  }
  return undefined;
}

function classKind(word: string): string {
  return word === 'namespace' || word === 'module' ? 'namespace' : word;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

/**
 * Index of the last line of the block that starts at `start`: the closing line at the
 * opener's indentation (`}`, `)`, `end`), or the last more-indented line (Python).
 * Undefined when no line below is indented deeper (not a block).
 */
function blockEnd(lines: string[], start: number): number | undefined {
  const base = indentOf(lines[start]!);
  let lastInner: number | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (indent > base) {
      lastInner = i;
      continue;
    }
    const trimmed = text.trim();
    // End of a multi-line signature at the opener's indent: `) {` / `): T {` / `):`.
    if (/^[)\]>]/.test(trimmed) && /[{:]$/.test(trimmed)) continue;
    if (lastInner === undefined) return undefined;
    return /^([}\])]|end\b)/.test(trimmed) ? i : lastInner;
  }
  return lastInner;
}

/** Builds a tree from a flat, start-ordered list using range containment. */
function nest(flat: CodeSymbol[]): CodeSymbol[] {
  const roots: CodeSymbol[] = [];
  const stack: CodeSymbol[] = [];
  for (const symbol of flat) {
    while (stack.length && stack.at(-1)!.endLine < symbol.startLine) stack.pop();
    const parent = stack.at(-1);
    if (parent && symbol.endLine <= parent.endLine) {
      (parent.children ??= []).push(symbol);
    } else {
      // Overlapping without containment: treat as a sibling of the parent's level.
      while (stack.length && stack.at(-1)!.endLine < symbol.endLine) stack.pop();
      const outer = stack.at(-1);
      if (outer) (outer.children ??= []).push(symbol);
      else roots.push(symbol);
    }
    stack.push(symbol);
  }
  return roots;
}
