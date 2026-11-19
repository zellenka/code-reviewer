import { z } from 'zod';
import { splitLines } from '../diff/parse';
import type { WorkspaceTools } from '../diff/types';
import type { ToolDef } from '../provider/types';
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
  const defs = new Map(reviewToolDefs(options).map((d) => [d.name, d]));
  const def = (name: (typeof AGENT_TOOL_NAMES)[number]) => defs.get(name)!;
  const redact = (text: string) =>
    redactText(text, { highEntropy: !!options.redactHighEntropy }).text;
  const blocked = (p: string) => isProtectedPath(p) || !!options.isBlocked?.(p);
  const clean = (p: string): string => {
    const out = normalize(p);
    if (blocked(out)) throw new Error(`${out} can't be read: it may contain secrets.`);
    return out;
  };
  const read = async (p: string, signal: AbortSignal, range?: { start: number; end: number }) => {
    try {
      return await ws.readFile(p, range, signal);
    } catch (err) {
      signal.throwIfAborted();
      throw friendly(err, p);
    }
  };
  /**
   * Every tool's errors go back to the model, so none may show where the repo lives: an
   * error with a code (`EBUSY: …, open 'C:\Users\…'`) becomes `failed (EBUSY).`, and the
   * root and other absolute paths are cut out of any other message (git, language server).
   */
  const guarded = <I>(tool: AgentTool<I>, failed: (input: I) => string): AgentTool<I> => ({
    ...tool,
    async run(input, signal) {
      try {
        return await tool.run(input, signal);
      } catch (err) {
        signal.throwIfAborted();
        const code = errorCode(err);
        const message = code
          ? `${failed(input)} (${code}).`
          : err instanceof Error
            ? err.message
            : String(err);
        // The loop sends only the message; the cause is for debugging.
        throw new Error(scrubPaths(message, ws.root), { cause: err });
      }
    },
  });
  /**
   * The redacted lines of text read from the start of a file. Tools cut their output from
   * these: a private key body is only known after its BEGIN line, so a part of a file can't
   * be redacted on its own.
   */
  const redactedLines = (text: string) => splitLines(redact(text));

  const readFile: AgentTool<{ path: string; startLine?: number; endLine?: number }> = {
    def: def('read_file'),
    schema: z.object({ path, startLine: line.optional(), endLine: line.optional() }),
    describe: (i) => `${i.path}${i.startLine ? `:${i.startLine}-${i.endLine ?? ''}` : ''}`,
    async run(input, signal) {
      const p = clean(input.path);
      const start = input.startLine ?? 1;
      const end = Math.min(input.endLine ?? start + maxLines - 1, start + maxLines - 1);
      if (end < start) throw new Error('endLine is before startLine.');
      const all = redactedLines(await read(p, signal));
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
      const hits = (await ws.grep(input.pattern, input.glob, signal)).filter(
        (h) => !blocked(h.path),
      );
      if (!hits.length) return 'No matches.';
      const files = new Map<string, { raw: string[]; redacted: string[] }>();
      const shown: string[] = [];
      for (const h of hits.slice(0, maxMatches)) {
        // A failed read shows the file's hits as unchecked; a cancelled review stops here.
        signal.throwIfAborted();
        let file = files.get(h.path);
        if (!file) {
          const text = await read(h.path, signal).catch(() => '');
          file = { raw: splitLines(text), redacted: redactedLines(text) };
          files.set(h.path, file);
        }
        // The hit's text is shown from the redacted file. A line that isn't there (the host
        // cut a large file, or it changed) can't be checked, so its text is left out.
        const found = file.raw[h.line - 1]?.includes(h.text.trim());
        const lineText = found
          ? file.redacted[h.line - 1]!.trim().slice(0, 500)
          : '[line not shown: it could not be checked for secrets]';
        shown.push(`${h.path}:${h.line}: ${lineText}`);
      }
      if (hits.length > maxMatches) shown.push(`… more matches; narrow the pattern or glob.`);
      return shown.join('\n');
    },
  };

  const findReferences: AgentTool<{ path: string; line: number; symbol: string }> = {
    def: def('find_references'),
    schema: z.object({ path, line, symbol: z.string().min(1).max(200) }),
    describe: (i) => `${i.path}:${i.line}`,
    async run(input, signal) {
      const p = clean(input.path);
      const range = { start: input.line, end: input.line };
      const text = (await read(p, signal, range)).split('\n')[0] ?? '';
      const col = wordIndex(text, input.symbol);
      if (col < 0) throw new Error(`"${input.symbol}" is not on line ${input.line} of ${p}.`);
      const refs = (await ws.findReferences(p, input.line, col + 1, signal)).filter(
        (r) => !blocked(r.path),
      );
      if (!refs.length) return 'No references found.';
      const files = new Map<string, string[]>();
      const shown: string[] = [];
      for (const ref of refs.slice(0, maxMatches)) {
        signal.throwIfAborted();
        if (!files.has(ref.path) && files.size < 20) {
          files.set(ref.path, redactedLines(await read(ref.path, signal).catch(() => '')));
        }
        const lineText = files.get(ref.path)?.[ref.line - 1]?.trim() ?? '';
        shown.push(`${ref.path}:${ref.line}: ${lineText.slice(0, 300)}`);
      }
      if (refs.length > maxMatches) shown.push(`… ${refs.length - maxMatches} more.`);
      return shown.join('\n');
    },
  };

  const getSymbol: AgentTool<{ path: string; line: number }> = {
    def: def('get_symbol'),
    schema: z.object({ path, line }),
    describe: (i) => `${i.path}:${i.line}`,
    async run(input, signal) {
      const p = clean(input.path);
      const content = await read(p, signal);
      let symbol = await ws.getSymbolAt(p, input.line).catch(() => null);
      if (!symbol) {
        const inner = enclosingSymbols(heuristicSymbols(content), input.line).at(-1);
        if (inner) symbol = inner;
      }
      if (!symbol) return `No enclosing function or class found at ${p}:${input.line}.`;
      const lines = redactedLines(content).slice(symbol.startLine - 1, symbol.endLine);
      const shown = lines.slice(0, maxLines);
      const more = lines.length > maxLines ? `\n… (${lines.length - maxLines} more lines)` : '';
      return `${symbol.kind} ${symbol.name} (${p} lines ${symbol.startLine}-${symbol.endLine}):\n${numbered(shown, symbol.startLine)}${more}`;
    },
  };

  return [
    guarded(readFile, (i) => `${normalize(i.path)} can't be read`),
    guarded(searchCode, () => 'The search failed'),
    guarded(findReferences, (i) => `References in ${normalize(i.path)} can't be found`),
    guarded(getSymbol, (i) => `${normalize(i.path)} can't be read`),
  ] as unknown as AgentTool<never>[];
}

/** A repo-relative path as the model may write it: `.\src\a.ts` → `src/a.ts`. */
function normalize(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
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
  const code = errorCode(err);
  if (code === 'ENOENT') return new Error(`File not found: ${p}`);
  if (code === 'EISDIR') return new Error(`${p} is a directory.`);
  if (code) return new Error(`${p} can't be read (${code}).`);
  return err instanceof Error ? err : new Error(String(err));
}

/** Node's error code (`EBUSY`, `ERR_FS_FILE_TOO_LARGE`), if any. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}

/**
 * Absolute paths, which can contain a user name: quoted (spaces allowed, as Node quotes
 * them), `file:` URIs, drive and UNC paths, and POSIX paths of two or more parts.
 */
const ABSOLUTE_PATH = new RegExp(
  [
    String.raw`(['"\`])(?:[A-Za-z]:[\\/]|\\\\|/|file:)[^'"\`\r\n]*\1`,
    String.raw`\bfile:[^\s'"\`]+`,
    String.raw`\b[A-Za-z]:[\\/][^\s'"\`]*`,
    String.raw`\\\\[^\s'"\`\\]+\\[^\s'"\`]*`,
    String.raw`(?<=^|[\s(=,:])/[^\s'"\`/]+/[^\s'"\`]*`,
  ].join('|'),
  'g',
);

/**
 * `text` without the repo root (paths under it become repo-relative, in either slash
 * direction and any letter case) or any other absolute path (`<path>`).
 */
function scrubPaths(text: string, root?: string): string {
  const parts = root?.split(/[\\/]+/).filter(Boolean) ?? [];
  if (parts.length) {
    const escaped = parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const lead = root!.startsWith('/') || root!.startsWith('\\') ? '[\\\\/]+' : '';
    const rootRe = `${lead}${escaped.join('[\\\\/]+')}`;
    text = text
      .replace(new RegExp(`${rootRe}[\\\\/]+`, 'gi'), '')
      .replace(new RegExp(`${rootRe}(?=$|[\\s'"\`,;:)\\]])`, 'gi'), '.');
  }
  return text.replace(ABSOLUTE_PATH, (_match, quote: string | undefined) =>
    quote ? `${quote}<path>${quote}` : '<path>',
  );
}
