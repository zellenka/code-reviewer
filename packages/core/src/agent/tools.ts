import { z } from 'zod';
import { splitLines } from '../diff/parse';
import type { WorkspaceTools } from '../diff/types';
import { isProtectedPath } from '../review/filter';
import { redactText } from '../review/redact';
import { enclosingSymbols, heuristicSymbols } from '../review/symbols';
import type { AgentTool } from './loop';

export interface ReviewToolsOptions {
  /** More paths the agent may not read (secrets and `.git/` are always refused). */
  isBlocked?: (path: string) => boolean;
  /** Same as the review's `redactHighEntropy`. Known secret formats are always redacted. */
  redactHighEntropy?: boolean;
  /** Lines per `read_file` / `get_symbol` result. Default 400. */
  maxLines?: number;
  /** Matches per `search_code` / `find_references` result. Default 50. */
  maxMatches?: number;
}

export const AGENT_TOOL_NAMES = [
  'read_file',
  'search_code',
  'find_references',
  'get_symbol',
] as const;

const path = z.string().min(1).describe('Repository-relative path, e.g. "src/a.ts".');
const line = z.coerce.number().int().min(1);

/**
 * The read-only tools of agentic reviews, on top of a host's `WorkspaceTools`
 * (which sandboxes paths to the repo). Adds what every host needs: secret files and
 * `.git/` are refused, output is redacted like diffs, and results are size-capped.
 */
export function createReviewTools(
  ws: WorkspaceTools,
  options: ReviewToolsOptions = {},
): AgentTool<never>[] {
  const maxLines = options.maxLines ?? 400;
  const maxMatches = options.maxMatches ?? 50;
  const redact = (text: string) =>
    redactText(text, { highEntropy: !!options.redactHighEntropy }).text;
  const blocked = (p: string) => isProtectedPath(p) || !!options.isBlocked?.(p);
  const clean = (p: string): string => {
    const out = p
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '');
    if (blocked(out)) throw new Error(`${out} can't be read: it may contain secrets.`);
    return out;
  };
  const read = async (p: string, range?: { start: number; end: number }) => {
    try {
      return await ws.readFile(p, range);
    } catch (err) {
      throw friendly(err, p);
    }
  };

  const readFile: AgentTool<{ path: string; startLine?: number; endLine?: number }> = {
    def: {
      name: 'read_file',
      description: `Read a file in the repository (new version, with line numbers). Without a range, returns the first ${maxLines} lines. Use startLine/endLine for a part of a long file.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path, e.g. "src/a.ts".' },
          startLine: { type: 'integer', description: 'First line (1-based).' },
          endLine: { type: 'integer', description: 'Last line (inclusive).' },
        },
        required: ['path'],
      },
    },
    schema: z.object({ path, startLine: line.optional(), endLine: line.optional() }),
    describe: (i) => `${i.path}${i.startLine ? `:${i.startLine}-${i.endLine ?? ''}` : ''}`,
    async run(input) {
      const p = clean(input.path);
      const start = input.startLine ?? 1;
      const end = Math.min(input.endLine ?? start + maxLines - 1, start + maxLines - 1);
      if (end < start) throw new Error('endLine is before startLine.');
      const all = splitLines(await read(p));
      const slice = all.slice(start - 1, end);
      if (!slice.length) return `${p} has ${all.length} line(s); nothing at ${start}.`;
      const more =
        end < all.length ? `\n… (${all.length} lines in total; ask for startLine ${end + 1}+)` : '';
      return redact(
        `${p} lines ${start}-${start + slice.length - 1}:\n${numbered(slice, start)}${more}`,
      );
    },
  };

  const searchCode: AgentTool<{ pattern: string; glob?: string }> = {
    def: {
      name: 'search_code',
      description: `Search the repository for a regular expression (JavaScript syntax, one line at a time). Returns up to ${maxMatches} matching lines as path:line: text.`,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression, e.g. "\\\\bparseDate\\\\(".',
          },
          glob: { type: 'string', description: 'Optional file filter, e.g. "src/**/*.ts".' },
        },
        required: ['pattern'],
      },
    },
    schema: z.object({ pattern: z.string().min(1).max(500), glob: z.string().min(1).optional() }),
    describe: (i) => (i.glob ? `in ${i.glob}` : ''),
    async run(input) {
      const hits = (await ws.grep(input.pattern, input.glob)).filter((h) => !blocked(h.path));
      if (!hits.length) return 'No matches.';
      const shown = hits.slice(0, maxMatches).map((h) => `${h.path}:${h.line}: ${h.text.trim()}`);
      if (hits.length > maxMatches) shown.push(`… more matches; narrow the pattern or glob.`);
      return redact(shown.join('\n'));
    },
  };

  const findReferences: AgentTool<{ path: string; line: number; symbol: string }> = {
    def: {
      name: 'find_references',
      description: `Find where a symbol is used. Give the file and line where it appears (e.g. its declaration) and its name. Returns up to ${maxMatches} places as path:line: text.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File where the symbol appears.' },
          line: { type: 'integer', description: 'Line (1-based) where the symbol appears.' },
          symbol: { type: 'string', description: 'The identifier, e.g. "formatPrice".' },
        },
        required: ['path', 'line', 'symbol'],
      },
    },
    schema: z.object({ path, line, symbol: z.string().min(1).max(200) }),
    describe: (i) => `${i.path}:${i.line}`,
    async run(input) {
      const p = clean(input.path);
      const text = (await read(p, { start: input.line, end: input.line })).split('\n')[0] ?? '';
      const col = wordIndex(text, input.symbol);
      if (col < 0) throw new Error(`"${input.symbol}" is not on line ${input.line} of ${p}.`);
      const refs = (await ws.findReferences(p, input.line, col + 1)).filter(
        (r) => !blocked(r.path),
      );
      if (!refs.length) return 'No references found.';
      const files = new Map<string, string[]>();
      const shown: string[] = [];
      for (const ref of refs.slice(0, maxMatches)) {
        if (!files.has(ref.path) && files.size < 20) {
          files.set(ref.path, splitLines(await read(ref.path).catch(() => '')));
        }
        const lineText = files.get(ref.path)?.[ref.line - 1]?.trim() ?? '';
        shown.push(`${ref.path}:${ref.line}: ${lineText.slice(0, 300)}`);
      }
      if (refs.length > maxMatches) shown.push(`… ${refs.length - maxMatches} more.`);
      return redact(shown.join('\n'));
    },
  };

  const getSymbol: AgentTool<{ path: string; line: number }> = {
    def: {
      name: 'get_symbol',
      description:
        'Get the function, method or class that contains a line, with its full code (line-numbered).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path.' },
          line: { type: 'integer', description: 'A line (1-based) inside the symbol.' },
        },
        required: ['path', 'line'],
      },
    },
    schema: z.object({ path, line }),
    describe: (i) => `${i.path}:${i.line}`,
    async run(input) {
      const p = clean(input.path);
      const content = await read(p);
      let symbol = await ws.getSymbolAt(p, input.line).catch(() => null);
      if (!symbol) {
        const inner = enclosingSymbols(heuristicSymbols(content), input.line).at(-1);
        if (inner) symbol = inner;
      }
      if (!symbol) return `No enclosing function or class found at ${p}:${input.line}.`;
      const lines = splitLines(content).slice(symbol.startLine - 1, symbol.endLine);
      const shown = lines.slice(0, maxLines);
      const more = lines.length > maxLines ? `\n… (${lines.length - maxLines} more lines)` : '';
      return redact(
        `${symbol.kind} ${symbol.name} (${p} lines ${symbol.startLine}-${symbol.endLine}):\n${numbered(shown, symbol.startLine)}${more}`,
      );
    },
  };

  return [readFile, searchCode, findReferences, getSymbol] as unknown as AgentTool<never>[];
}

function numbered(lines: string[], start: number): string {
  return lines.map((l, i) => `${String(start + i).padStart(6)}  ${l}`).join('\n');
}

function wordIndex(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[^\\w$])(${escaped})(?![\\w$])`).exec(text);
  return m ? m.index + m[1]!.length : -1;
}

/** Hides absolute paths in fs errors (they'd leak the user's directory layout). */
function friendly(err: unknown, p: string): Error {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'ENOENT') return new Error(`File not found: ${p}`);
  if (code === 'EISDIR') return new Error(`${p} is a directory.`);
  return err instanceof Error ? err : new Error(String(err));
}
