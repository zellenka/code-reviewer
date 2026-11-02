import type { DiffLine, FileDiff, Hunk, UnifiedDiff } from './types';

/** Converts CRLF / CR line endings to `\n`. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Normalizes a path to repo-relative POSIX (`src/a.ts`). */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff` output (or a plain unified diff) into `UnifiedDiff`.
 * Handles added/deleted/renamed/binary files, mode-only changes, quoted paths,
 * CRLF and "\ No newline at end of file".
 */
export function parseUnifiedDiff(text: string): UnifiedDiff {
  const lines = normalizeEol(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: FileDiff[] = [];

  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  /** Paths from `--- a/x` / `+++ b/x`; null = /dev/null. */
  let minus: string | null | undefined;

  const finishFile = () => {
    if (file) files.push(file);
    file = undefined;
    hunk = undefined;
    minus = undefined;
  };
  const startFile = (path: string): FileDiff => {
    finishFile();
    file = { path, status: 'modified', binary: false, hunks: [] };
    return file;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Inside a hunk: count lines by the header so content like "--- x" isn't misread.
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const kind = line[0];
      if (kind === '+' || kind === '-' || kind === ' ' || line === '') {
        const body = line.slice(1);
        let entry: DiffLine;
        if (kind === '+') {
          entry = { kind: 'add', text: body, newLine: newLine++ };
          newLeft--;
        } else if (kind === '-') {
          entry = { kind: 'del', text: body, oldLine: oldLine++ };
          oldLeft--;
        } else {
          // A blank line can be an empty context line when the trailing space was stripped.
          entry = { kind: 'ctx', text: body, oldLine: oldLine++, newLine: newLine++ };
          oldLeft--;
          newLeft--;
        }
        hunk.lines.push(entry);
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      // Malformed hunk: fall through and treat as a header line.
      oldLeft = newLeft = 0;
    }
    if (line.startsWith('\\')) continue;

    if (line.startsWith('diff --git ')) {
      const paths = parseGitHeaderPaths(line.slice('diff --git '.length));
      startFile(paths?.newPath ?? paths?.oldPath ?? '');
      if (paths && paths.oldPath !== paths.newPath) file!.oldPath = paths.oldPath;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      file ??= startFile('');
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      hunk = {
        oldStart: oldLine,
        oldLines: oldLeft,
        newStart: newLine,
        newLines: newLeft,
        lines: [],
      };
      // With 0 lines git reports the line *before* the change; real lines start one later.
      if (oldLeft === 0) oldLine++;
      if (newLeft === 0) newLine++;
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith('--- ')) {
      // Plain unified diff (no "diff --git" header) starts a new file here.
      if (!file || file.hunks.length > 0) startFile('');
      minus = parseMarkerPath(line.slice(4), 'a/');
      continue;
    }
    if (line.startsWith('+++ ') && file && minus !== undefined) {
      const plus = parseMarkerPath(line.slice(4), 'b/');
      if (minus === null) file.status = 'added';
      if (plus === null) file.status = 'deleted';
      const newPath = plus ?? minus;
      const oldPath = minus ?? plus;
      if (newPath) file.path = newPath;
      if (oldPath && newPath && oldPath !== newPath) file.oldPath = oldPath;
      else if (file.status !== 'renamed') delete file.oldPath;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.oldPath = unquote(line.slice('rename from '.length));
      file.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      file.path = unquote(line.slice('rename to '.length));
      file.status = 'renamed';
    } else if (line.startsWith('copy to ')) {
      file.path = unquote(line.slice('copy to '.length));
      file.status = 'added';
      delete file.oldPath;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
      const bin = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (bin) {
        if (bin[1] === '/dev/null') file.status = 'added';
        if (bin[2] === '/dev/null') file.status = 'deleted';
      }
    }
  }
  finishFile();

  for (const f of files) {
    f.path = toPosixPath(f.path);
    if (f.oldPath) f.oldPath = toPosixPath(f.oldPath);
    if (f.status === 'modified' && f.oldPath && f.oldPath !== f.path) f.status = 'renamed';
  }
  return { files: files.filter((f) => f.path !== '') };
}

/** `--- a/x` → `x`; `/dev/null` → null. Strips the a/ or b/ prefix and a trailing tab+timestamp. */
function parseMarkerPath(raw: string, prefix: string): string | null {
  let value = raw;
  if (!value.startsWith('"')) value = value.replace(/\t.*$/, '');
  value = unquote(value.trimEnd());
  if (value === '/dev/null') return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Paths from `diff --git a/x b/y`. Ambiguous with spaces; rename/---/+++ lines win later. */
function parseGitHeaderPaths(rest: string): { oldPath: string; newPath: string } | undefined {
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest, 0);
    const first = unquote(rest.slice(0, end + 1));
    const second = unquote(rest.slice(end + 2));
    return { oldPath: stripPrefix(first, 'a/'), newPath: stripPrefix(second, 'b/') };
  }
  const quoted = rest.indexOf(' "');
  if (quoted !== -1) {
    return {
      oldPath: stripPrefix(rest.slice(0, quoted), 'a/'),
      newPath: stripPrefix(unquote(rest.slice(quoted + 1)), 'b/'),
    };
  }
  // Same path on both sides (the usual case): "a/<p> b/<p>".
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) {
      return { oldPath: a.slice(2), newPath: b.slice(2) };
    }
  }
  const split = rest.indexOf(' b/');
  if (split === -1) return undefined;
  return {
    oldPath: stripPrefix(rest.slice(0, split), 'a/'),
    newPath: rest.slice(split + 3),
  };
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function findQuoteEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

const ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  b: 8,
  f: 12,
  v: 11,
  a: 7,
  '\\': 92,
  '"': 34,
};

/** Undoes git's C-style path quoting, including octal-escaped UTF-8 bytes. */
export function unquote(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"') && value.length >= 2)) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Builds a diff that shows `content` as entirely added (untracked files, file/selection review). */
export function addedFileDiff(
  path: string,
  content: string,
  options: { startLine?: number; endLine?: number; status?: FileDiff['status'] } = {},
): FileDiff {
  const normalized = normalizeEol(content);
  if (normalized.includes('\0')) {
    return { path, status: options.status ?? 'added', binary: true, hunks: [] };
  }
  const all = splitLines(normalized);
  const start = Math.max(1, options.startLine ?? 1);
  const end = Math.min(all.length, options.endLine ?? all.length);
  const lines: DiffLine[] = [];
  for (let n = start; n <= end; n++) lines.push({ kind: 'add', text: all[n - 1]!, newLine: n });
  const hunks: Hunk[] = lines.length
    ? [{ oldStart: 0, oldLines: 0, newStart: start, newLines: lines.length, lines }]
    : [];
  return { path, status: options.status ?? 'added', binary: false, hunks, newContent: normalized };
}

/** Splits text into lines without a phantom empty line after a trailing newline. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
