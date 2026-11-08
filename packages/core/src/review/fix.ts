import { normalizeEol } from '../diff/parse';
import { locateQuote, normalizeWhitespace, type LocateOptions } from './anchor';
import type { Finding } from './types';

/**
 * A text replacement in a document. Lines are 1-based; columns are 0-based
 * character offsets, end exclusive. `newText` uses `\n`; hosts convert it to the
 * document's line ending.
 */
export interface FixEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
}

/**
 * Computes the edit that replaces a finding's `quote` with its `suggestion` in the
 * current document lines. The quote is re-anchored first. Returns undefined when
 * there's no suggestion, or the quote can't be found reliably (fuzzy matches are
 * not used: the code changed, and replacing it could lose the user's edits).
 * Pass `searchRange` to only look near the finding, so an identical line elsewhere
 * in the file is never edited.
 */
export function computeFix(
  lines: readonly string[],
  finding: Pick<Finding, 'quote' | 'suggestion' | 'startLine'>,
  options: Pick<LocateOptions, 'searchRange'> = {},
): FixEdit | undefined {
  if (finding.suggestion === undefined) return undefined;
  const match = locateQuote(lines, finding.quote, {
    nearLine: finding.startLine,
    ...(options.searchRange ? { searchRange: options.searchRange } : {}),
  });
  if (!match || match.method === 'fuzzy') return undefined;

  const q = match.quoteLines;
  const first = lines[match.startLine - 1]!;
  const last = lines[match.endLine - 1]!;
  let startColumn: number;
  let endColumn: number;

  if (match.method === 'exact') {
    if (q.length === 1) {
      startColumn = nearestIndex(first, q[0]!);
      endColumn = startColumn + q[0]!.length;
    } else {
      startColumn = first.length - q[0]!.length;
      endColumn = q.at(-1)!.length;
    }
  } else {
    // Whitespace differs: only safe when the quote covers whole lines (ignoring indent).
    const whole =
      normalizeWhitespace(first) === normalizeWhitespace(q[0]!) &&
      normalizeWhitespace(last) === normalizeWhitespace(q.at(-1)!);
    if (!whole) return undefined;
    startColumn = indentOf(first);
    endColumn = last.length;
  }

  let newText = normalizeEol(finding.suggestion);
  // The range never includes the final line break, so drop one from the suggestion.
  if (endColumn === last.length && newText.endsWith('\n')) newText = newText.slice(0, -1);
  // When the range starts after the indent, the suggestion's own indent would double it.
  if (startColumn > 0 && startColumn === indentOf(first)) {
    const [head, ...rest] = newText.split('\n');
    newText = [head!.trimStart(), ...rest].join('\n');
  }

  return {
    startLine: match.startLine,
    startColumn,
    endLine: match.endLine,
    endColumn,
    newText,
  };
}

/** Applies a FixEdit to LF text (for previews and tests). */
export function applyFixToText(text: string, edit: FixEdit): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Plain split keeps a trailing empty line, so a final newline survives.
  const lines = normalizeEol(text).split('\n');
  const before = lines.slice(0, edit.startLine - 1);
  const head = lines[edit.startLine - 1]!.slice(0, edit.startColumn);
  const tail = lines[edit.endLine - 1]!.slice(edit.endColumn);
  const after = lines.slice(edit.endLine);
  const middle = (head + edit.newText + tail).split('\n');
  return [...before, ...middle, ...after].join(eol);
}

function indentOf(line: string): number {
  const i = line.search(/\S/);
  return i < 0 ? line.length : i;
}

/** First occurrence; quotes are short, so a repeated substring on one line is rare. */
function nearestIndex(line: string, part: string): number {
  return Math.max(0, line.indexOf(part));
}
