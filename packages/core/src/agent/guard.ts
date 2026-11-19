import picomatch from 'picomatch';
import { DiffSourceError } from '../diff/errors';
import { splitLines } from '../diff/parse';
import type { WorkspaceTools } from '../diff/types';
import { isProtectedPath } from '../review/filter';
import { redactText } from '../review/redact';

export interface GuardOptions {
  /** More paths the agent may not read (secrets and `.git/` are always refused). */
  isBlocked?: (path: string) => boolean;
  /** Same as the review's `redactHighEntropy`. Known secret formats are always redacted. */
  redactHighEntropy?: boolean;
}

/** A line the model may be shown, from the redacted file. */
export interface GuardedLine {
  path: string;
  line: number;
  /** Undefined when the line can't be checked for secrets (the host cut the file, or it changed). */
  text?: string;
}

/**
 * What the model may see of a workspace (`guardWorkspace`). Paths are as the model writes
 * them; every error message is safe to send to the model.
 */
export interface GuardedWorkspace {
  /** A path as it is shown: `.\src\a.ts` → `src/a.ts`. */
  normalize(path: string): string;
  /** A whole file, redacted, in lines. */
  readLines(path: string, signal: AbortSignal): Promise<string[]>;
  /** The first `limit` hits of a search, and how many there are in all. */
  search(
    pattern: string,
    glob: string | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ hits: GuardedLine[]; total: number }>;
  /** The first `limit` places that use the symbol at `line`/`col` (1-based), and how many in all. */
  findReferences(
    path: string,
    line: number,
    col: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ refs: GuardedLine[]; total: number }>;
  getSymbolAt(
    path: string,
    line: number,
    signal: AbortSignal,
  ): ReturnType<WorkspaceTools['getSymbolAt']>;
}

/** A file the model may not read. Its search hits and references are left out. */
class RefusedError extends Error {}

/** Lines of a file read for hits: raw (to check the hit) and redacted (to show it). */
interface HitFile {
  raw: string[];
  redacted: string[];
}

/**
 * The one gate between a host's raw `WorkspaceTools` and the model (A1). A path is refused
 * when it names a secret file or `.git/` (`isProtectedPath`, also for the target of a
 * symlink), is blocked by `options`, or is a file git doesn't show (`listFiles`; often local
 * secrets the protected list doesn't name). Files are redacted whole before any part of them
 * is shown (a private key body is only known after its BEGIN line), and no error shows where
 * the repo lives. Hosts only do IO; `createReviewTools` applies this to every host.
 */
export function guardWorkspace(ws: WorkspaceTools, options: GuardOptions = {}): GuardedWorkspace {
  const key = (p: string) => (ws.caseInsensitive ? p.toLowerCase() : p);
  const blocked = (p: string) => isProtectedPath(p) || !!options.isBlocked?.(p);
  const redact = (text: string) =>
    redactText(text, { highEntropy: !!options.redactHighEntropy }).text;
  const secret = (p: string) => new RefusedError(`${p} can't be read: it may contain secrets.`);
  const notShown = (p: string) =>
    new RefusedError(`${p} can't be read: it is ignored by git or missing.`);

  let listing: Promise<{ files: string[]; keys: Set<string> }> | undefined;
  /** `listFiles`, once per guard (one review): a file created during the review is not shown. */
  const listed = (signal: AbortSignal) => {
    if (!listing) {
      const pending = ws.listFiles(signal).then((files) => {
        const paths = files.map(toSlash);
        return { files: paths.sort(compareRepoPaths), keys: new Set(paths.map(key)) };
      });
      // A cancelled or failed listing is tried again by the next call.
      pending.catch(() => {
        if (listing === pending) listing = undefined;
      });
      listing = pending;
    }
    return listing;
  };
  /** Whether a path from the host (a hit, a reference) is in a file the model may see. */
  const mayShow = (p: string, keys: Set<string>) => !blocked(p) && keys.has(key(p));

  /**
   * The repo path of a file the model may read. Checked by name first, so the answer doesn't
   * tell whether an ignored file exists; then by where it really is, so a symlink can't reach
   * a secret or ignored file. A path under a listed symlink (git lists the link) is checked
   * by its target.
   */
  const check = async (input: string, signal: AbortSignal): Promise<string> => {
    const shown = normalize(input);
    const p = resolveRepoPath(input);
    if (blocked(p)) throw secret(shown);
    const { keys } = await listed(signal);
    const viaLink = !keys.has(key(p));
    if (viaLink && !ancestors(p).some((dir) => keys.has(key(dir)))) throw notShown(shown);
    let real: string;
    try {
      real = toSlash(await ws.realPath(p, signal));
    } catch (err) {
      signal.throwIfAborted();
      if (viaLink) throw notShown(shown);
      throw err;
    }
    if (blocked(real)) throw secret(shown);
    if (!keys.has(key(real))) throw notShown(shown);
    return p;
  };
  const readRaw = async (input: string, signal: AbortSignal) =>
    ws.readFile(await check(input, signal), undefined, signal);

  /**
   * Every error goes back to the model, so none may show where the repo lives: an error with a
   * code (`EBUSY: …, open 'C:\Users\…'`) becomes `failed (EBUSY).`, and the root and other
   * absolute paths are cut out of any other message (git, language server). A cancelled call
   * rejects with the abort reason.
   */
  const scrubbed = (err: unknown, signal: AbortSignal, failed: string): Error => {
    signal.throwIfAborted();
    if (err instanceof RefusedError) return err;
    const code = errorCode(err);
    const message = code
      ? `${failed} (${code}).`
      : err instanceof Error
        ? err.message
        : String(err);
    // The loop sends only the message; the cause is for debugging.
    return new Error(scrubPaths(message, ws.root), { cause: err });
  };
  const readFailed = (err: unknown, signal: AbortSignal, p: string): Error => {
    signal.throwIfAborted();
    const code = errorCode(err);
    if (code === 'ENOENT') return new Error(`File not found: ${p}`);
    if (code === 'EISDIR') return new Error(`${p} is a directory.`);
    return scrubbed(err, signal, `${p} can't be read`);
  };

  return {
    normalize,

    async readLines(input, signal) {
      try {
        return splitLines(redact(await readRaw(input, signal)));
      } catch (err) {
        throw readFailed(err, signal, normalize(input));
      }
    },

    async search(pattern, glob, limit, signal) {
      try {
        const { files, keys } = await listed(signal);
        const inGlob = glob ? picomatch(glob, { dot: true }) : undefined;
        // Files the model may not read are never even searched: no hit hints at their content.
        const paths = files.filter((p) => !blocked(p) && (!inGlob || inGlob(p)));
        const hits = (await ws.grep(pattern, paths, signal))
          .map((h) => ({ ...h, path: toSlash(h.path) }))
          .filter((h) => mayShow(h.path, keys));
        const read = new Map<string, HitFile | null>();
        const shown: GuardedLine[] = [];
        let refused = 0;
        for (const h of hits.slice(0, limit)) {
          // A failed read shows the file's hits as unchecked; a cancelled review stops here.
          signal.throwIfAborted();
          let file = read.get(h.path);
          if (file === undefined) {
            file = await readRaw(h.path, signal).then(
              (text) => ({ raw: splitLines(text), redacted: splitLines(redact(text)) }),
              (err: unknown) => (err instanceof RefusedError ? null : { raw: [], redacted: [] }),
            );
            read.set(h.path, file);
          }
          if (!file) {
            refused++;
            continue;
          }
          // A line that isn't there (the host cut a large file, or it changed) can't be checked.
          const checked = file.raw[h.line - 1]?.includes(h.text.trim());
          shown.push({
            path: h.path,
            line: h.line,
            ...(checked ? { text: file.redacted[h.line - 1]! } : {}),
          });
        }
        return { hits: shown, total: hits.length - refused };
      } catch (err) {
        throw scrubbed(err, signal, 'The search failed');
      }
    },

    async findReferences(input, line, col, limit, signal) {
      try {
        const p = await check(input, signal);
        const { keys } = await listed(signal);
        const refs = (await ws.findReferences(p, line, col, signal))
          .map((r) => ({ ...r, path: toSlash(r.path) }))
          .filter((r) => mayShow(r.path, keys));
        const files = new Map<string, string[] | null>();
        const shown: GuardedLine[] = [];
        let refused = 0;
        for (const ref of refs.slice(0, limit)) {
          signal.throwIfAborted();
          if (!files.has(ref.path) && files.size < 20) {
            const lines = await readRaw(ref.path, signal).then(
              (text) => splitLines(redact(text)),
              (err: unknown) => (err instanceof RefusedError ? null : []),
            );
            files.set(ref.path, lines);
          }
          const lines = files.get(ref.path);
          if (lines === null) {
            refused++;
            continue;
          }
          shown.push({ path: ref.path, line: ref.line, text: lines?.[ref.line - 1] ?? '' });
        }
        return { refs: shown, total: refs.length - refused };
      } catch (err) {
        throw scrubbed(err, signal, `References in ${normalize(input)} can't be found`);
      }
    },

    async getSymbolAt(input, line, signal) {
      try {
        return await ws.getSymbolAt(await check(input, signal), line);
      } catch (err) {
        throw readFailed(err, signal, normalize(input));
      }
    },
  };
}

/** A repo-relative path as the model may write it: `.\src\a.ts` → `src/a.ts`. */
function normalize(p: string): string {
  return toSlash(p.trim()).replace(/^(\.\/)+/, '');
}

function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `path` as a file of the repo, with `.` and `..` steps resolved (`src/../a.ts` → `a.ts`).
 * Throws `DiffSourceError('outsideRepo')` for absolute paths and steps out of the repo,
 * before any host call (hosts refuse them too, and symlinks out of the repo).
 */
export function resolveRepoPath(path: string): string {
  const p = normalize(path);
  const outside = () => new DiffSourceError('outsideRepo', `Path is outside the repository: ${p}`);
  if (!p || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw outside();
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '..') {
      if (!out.length) throw outside();
      out.pop();
    } else if (part && part !== '.') out.push(part);
  }
  return out.join('/') || '.';
}

/** `a/b/c` → `a/b`, `a`. */
function ancestors(rel: string): string[] {
  const out: string[] = [];
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
    out.push(rel.slice(0, i));
  }
  return out;
}

const collator = new Intl.Collator();

/**
 * Repo paths in the order of a directory walk: names compared level by level, as
 * `localeCompare` does. Searches go through files in this order.
 */
export function compareRepoPaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = collator.compare(x[i]!, y[i]!);
    if (order) return order;
  }
  return x.length - y.length;
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
