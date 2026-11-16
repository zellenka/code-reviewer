import { describe, expect, it } from 'vitest';
import { locateQuote } from './anchor';
import { applyFixToText, computeFix } from './fix';

const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n');

function fix(text: string, quote: string, suggestion: string | undefined, startLine = 1) {
  const edit = computeFix(lines(text), {
    quote,
    startLine,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
  return edit ? applyFixToText(text, edit) : undefined;
}

const SRC = 'export function sub(a, b) {\n  return a + b;\n}\n';

describe('computeFix', () => {
  it('replaces an exact single-line quote', () => {
    expect(fix(SRC, 'return a + b;', 'return a - b;')).toBe(
      'export function sub(a, b) {\n  return a - b;\n}\n',
    );
  });

  it('replaces only the quoted part of a line', () => {
    expect(fix(SRC, 'a + b', 'a - b')).toBe('export function sub(a, b) {\n  return a - b;\n}\n');
  });

  it('keeps CRLF line endings', () => {
    const crlf = SRC.replace(/\n/g, '\r\n');
    expect(fix(crlf, 'return a + b;', 'if (!a) return b;\nreturn a - b;')).toBe(
      'export function sub(a, b) {\r\n  if (!a) return b;\r\nreturn a - b;\r\n}\r\n',
    );
  });

  it('replaces a multi-line quote', () => {
    const text = 'function f() {\n  if (x) {\n    go();\n  }\n}\n';
    expect(fix(text, '  if (x) {\n    go();\n  }', '  if (x) go();')).toBe(
      'function f() {\n  if (x) go();\n}\n',
    );
  });

  it('handles whitespace differences when the quote covers whole lines', () => {
    const text = 'x();\n    return   a + b;\ny();\n';
    expect(fix(text, 'return a + b;', '  return a - b;\n')).toBe('x();\n    return a - b;\ny();\n');
  });

  it('re-anchors to the nearest match after the code moved', () => {
    const text = '// one\n// two\n' + SRC;
    expect(fix(text, 'return a + b;', 'return a - b;', 2)).toContain('return a - b;');
  });

  it('never edits an identical line outside the search range', () => {
    const text = 'a();\nreturn null;\nb();\nc();\nd();\nreturn null;\n';
    const edited = text.replace('return null;', 'return undefined;');
    const finding = { quote: 'return null;', suggestion: 'return 0;', startLine: 2 };
    expect(computeFix(lines(edited), finding, { searchRange: { start: 1, end: 4 } })).toBe(
      undefined,
    );
    // Within the range it still works.
    const edit = computeFix(lines(text), finding, { searchRange: { start: 1, end: 4 } });
    expect(edit && applyFixToText(text, edit)).toBe(
      'a();\nreturn 0;\nb();\nc();\nd();\nreturn null;\n',
    );
  });

  it('refuses when there is no suggestion, the quote is gone, or only fuzzy matches', () => {
    expect(fix(SRC, 'return a + b;', undefined)).toBeUndefined();
    expect(fix(SRC, 'completely different', 'x')).toBeUndefined();
    expect(locateQuote(lines(SRC), 'return a + bb;')?.method).toBe('fuzzy');
    expect(fix(SRC, 'return a + bb;', 'return a - b;')).toBeUndefined();
  });

  it('replaces a quote that is the whole line, indent included, keeping the suggestion indent', () => {
    expect(fix(SRC, '  return a + b;', '    return a - b;')).toBe(
      'export function sub(a, b) {\n    return a - b;\n}\n',
    );
  });

  it('replaces a multi-line quote that starts and ends mid-line', () => {
    const text = 'const v = f(\n  1,\n  2) + g();\n';
    expect(fix(text, 'f(\n  1,\n  2)', 'h(1, 2)')).toBe('const v = h(1, 2) + g();\n');
  });

  it('refuses a partial-line quote whose whitespace differs', () => {
    expect(fix(SRC, 'a  +  b', 'a - b')).toBeUndefined();
  });

  it('among identical lines near the finding, edits the nearest (the earlier on a tie)', () => {
    const text = 'a();\nreturn x;\nb();\nreturn x;\n';
    const finding = { quote: 'return x;', suggestion: 'return y;' };
    const at = (startLine: number) => computeFix(lines(text), { ...finding, startLine })?.startLine;
    expect(at(4)).toBe(4);
    expect(at(1)).toBe(2);
    expect(at(3)).toBe(2);
  });

  describe('a quote that is part of a line', () => {
    it('is not applied inside a longer name', () => {
      // `count` also occurs inside `discount`; the first occurrence must not be edited.
      expect(fix('const discount = count + 1;\n', 'count', 'total')).toBeUndefined();
      expect(fix('counter = 1;\n', 'count', 'total')).toBeUndefined();
      expect(fix('return $count + 1;\n', 'count', 'total')).toBeUndefined();
      expect(fix('return ñcount + 1;\n', 'count', 'total')).toBeUndefined();
    });

    it('is not applied when it occurs more than once on the line', () => {
      expect(fix('f(a + 1, a + 1);\n', 'a + 1', 'a - 1')).toBeUndefined();
      // Overlapping occurrences count too.
      expect(fix('x---y;\n', '--', '-')).toBeUndefined();
    });

    it('is applied when it occurs once, on identifier boundaries', () => {
      expect(fix('const total = count + 1;\n', 'count', 'total')).toBe(
        'const total = total + 1;\n',
      );
      expect(fix('return this.#count;\n', 'count', 'size')).toBe('return this.#size;\n');
    });

    it('is applied when its edges are punctuation, whatever is next to them', () => {
      expect(fix('return Math.round(a / b)+offset;\n', 'a / b', 'a * b')).toBe(
        'return Math.round(a * b)+offset;\n',
      );
      expect(fix('return f(x)+1;\n', '(x)', '(y)')).toBe('return f(y)+1;\n');
    });
  });

  it('does not apply a multi-line quote that starts or ends inside a longer name', () => {
    expect(fix('const discount = (\n  1);\n', 'count = (\n  1);', 'n = 1;')).toBeUndefined();
    expect(fix('f(\n  values);\n', 'f(\n  value', 'g(\n  value')).toBeUndefined();
  });
});
