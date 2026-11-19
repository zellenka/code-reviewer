import { z } from 'zod';
import type { WorkspaceTools } from '../diff/types';
import type { ToolDef } from '../provider/types';
import { enclosingSymbols, heuristicSymbols } from '../review/symbols';
import { guardWorkspace, type GuardOptions } from './guard';
import type { AgentTool } from './loop';

export interface ReviewToolsOptions extends GuardOptions {
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
 * Definitions of the read-only review tools, as sent to the model (same order as
 * `AGENT_TOOL_NAMES`). Needs no workspace: budgets and estimates count these.
 */
export function reviewToolDefs(
  options: Pick<ReviewToolsOptions, 'maxLines' | 'maxMatches'> = {},
): ToolDef[] {
  const maxLines = options.maxLines ?? 400;
  const maxMatches = options.maxMatches ?? 50;
  return [
    {
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
    {
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
    {
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
    {
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
  ];
}

/**
 * The read-only tools of agentic reviews, on top of a host's raw `WorkspaceTools`. Every
 * call goes through `guardWorkspace` (secret, `.git/` and git-ignored files refused, files
 * redacted whole, errors scrubbed), so no host can skip it. Results are size-capped.
 */
export function createReviewTools(
  ws: WorkspaceTools,
  options: ReviewToolsOptions = {},
): AgentTool<never>[] {
  const maxLines = options.maxLines ?? 400;
  const maxMatches = options.maxMatches ?? 50;
  const defs = new Map(reviewToolDefs(options).map((d) => [d.name, d]));
  const def = (name: (typeof AGENT_TOOL_NAMES)[number]) => defs.get(name)!;
  const guard = guardWorkspace(ws, options);

  const readFile: AgentTool<{ path: string; startLine?: number; endLine?: number }> = {
    def: def('read_file'),
    schema: z.object({ path, startLine: line.optional(), endLine: line.optional() }),
    describe: (i) => `${i.path}${i.startLine ? `:${i.startLine}-${i.endLine ?? ''}` : ''}`,
    async run(input, signal) {
      const p = guard.normalize(input.path);
      const start = input.startLine ?? 1;
      const end = Math.min(input.endLine ?? start + maxLines - 1, start + maxLines - 1);
      if (end < start) throw new Error('endLine is before startLine.');
      const all = await guard.readLines(input.path, signal);
      const slice = all.slice(start - 1, end);
      if (!slice.length) return `${p} has ${all.length} line(s); nothing at ${start}.`;
      const more =
        end < all.length ? `\n… (${all.length} lines in total; ask for startLine ${end + 1}+)` : '';
      return `${p} lines ${start}-${start + slice.length - 1}:\n${numbered(slice, start)}${more}`;
    },
  };

  const searchCode: AgentTool<{ pattern: string; glob?: string }> = {
    def: def('search_code'),
    schema: z.object({ pattern: z.string().min(1).max(500), glob: z.string().min(1).optional() }),
    describe: (i) => (i.glob ? `in ${i.glob}` : ''),
    async run(input, signal) {
      const { hits, total } = await guard.search(input.pattern, input.glob, maxMatches, signal);
      if (!total) return 'No matches.';
      // A hit whose line can't be checked against its redacted file is shown without text.
      const shown = hits.map(
        (h) =>
          `${h.path}:${h.line}: ${h.text === undefined ? '[line not shown: it could not be checked for secrets]' : h.text.trim().slice(0, 500)}`,
      );
      if (total > maxMatches) shown.push(`… more matches; narrow the pattern or glob.`);
      return shown.join('\n');
    },
  };

  const findReferences: AgentTool<{ path: string; line: number; symbol: string }> = {
    def: def('find_references'),
    schema: z.object({ path, line, symbol: z.string().min(1).max(200) }),
    describe: (i) => `${i.path}:${i.line}`,
    async run(input, signal) {
      const p = guard.normalize(input.path);
      const text = (await guard.readLines(input.path, signal))[input.line - 1] ?? '';
      const col = wordIndex(text, input.symbol);
      if (col < 0) throw new Error(`"${input.symbol}" is not on line ${input.line} of ${p}.`);
      const { refs, total } = await guard.findReferences(
        input.path,
        input.line,
        col + 1,
        maxMatches,
        signal,
      );
      if (!refs.length) return 'No references found.';
      const shown = refs.map((r) => `${r.path}:${r.line}: ${(r.text ?? '').trim().slice(0, 300)}`);
      if (total > maxMatches) shown.push(`… ${total - maxMatches} more.`);
      return shown.join('\n');
    },
  };

  const getSymbol: AgentTool<{ path: string; line: number }> = {
    def: def('get_symbol'),
    schema: z.object({ path, line }),
    describe: (i) => `${i.path}:${i.line}`,
    async run(input, signal) {
      const p = guard.normalize(input.path);
      const lines = await guard.readLines(input.path, signal);
      let symbol = await guard.getSymbolAt(input.path, input.line, signal).catch(() => null);
      if (!symbol) {
        const inner = enclosingSymbols(heuristicSymbols(lines.join('\n')), input.line).at(-1);
        if (inner) symbol = inner;
      }
      if (!symbol) return `No enclosing function or class found at ${p}:${input.line}.`;
      const body = lines.slice(symbol.startLine - 1, symbol.endLine);
      const shown = body.slice(0, maxLines);
      const more = body.length > maxLines ? `\n… (${body.length - maxLines} more lines)` : '';
      return `${symbol.kind} ${symbol.name} (${p} lines ${symbol.startLine}-${symbol.endLine}):\n${numbered(shown, symbol.startLine)}${more}`;
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
