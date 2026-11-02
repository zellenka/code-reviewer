import { describe, expect, it } from 'vitest';
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

  it('refuses when there is no suggestion, the quote is gone, or only fuzzy matches', () => {
    expect(fix(SRC, 'return a + b;', undefined)).toBeUndefined();
    expect(fix(SRC, 'completely different', 'x')).toBeUndefined();
    expect(fix(SRC, 'return a + bb;', 'return a - b;')).toBeUndefined();
  });
});
