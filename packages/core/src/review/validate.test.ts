import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ReviewConfig } from '../config/schema';
import { parseUnifiedDiff } from '../diff/parse';
import type { FileDiff } from '../diff/types';
import { locateQuote, similarity } from './anchor';
import { extractJson, parseFindingsInput } from './output';
import type { RawFinding } from './types';
import { fingerprint, validateFindings } from './validate';

const CONTENT = [
  'function total(items) {', // 1
  '  let sum = 0;', // 2
  '  for (let i = 0; i <= items.length; i++) {', // 3
  '    sum += items[i].price;', // 4
  '  }', // 5
  '  return sum;', // 6
  '}', // 7
  '', // 8
  'function avg(items) {', // 9
  '  let sum = 0;', // 10
  '  return total(items) / items.length;', // 11
  '}', // 12
].join('\n');

function modified(content = CONTENT): FileDiff {
  const diff = parseUnifiedDiff(`diff --git a/src/cart.js b/src/cart.js
--- a/src/cart.js
+++ b/src/cart.js
@@ -1,7 +1,7 @@
 function total(items) {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
     sum += items[i].price;
   }
   return sum;
 }
@@ -9,4 +9,4 @@
 function avg(items) {
   let sum = 0;
-  return total(items) / items.length || 0;
+  return total(items) / items.length;
 }
`).files[0]!;
  return { ...diff, newContent: `${content}\n` };
}

const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  file: 'src/cart.js',
  startLine: 3,
  endLine: 3,
  severity: 'major',
  category: 'bug',
  title: 'Off by one',
  body: 'Reads past the end.',
  quote: 'for (let i = 0; i <= items.length; i++) {',
  confidence: 0.9,
  ...over,
});

const run = (findings: RawFinding[], config: ReviewConfig = DEFAULT_CONFIG, file = modified()) =>
  validateFindings(findings, { config, files: [file] });

describe('locateQuote', () => {
  const lines = CONTENT.split('\n');

  it('exact, normalized and fuzzy matching', () => {
    expect(locateQuote(lines, 'sum += items[i].price;')).toMatchObject({
      startLine: 4,
      method: 'exact',
    });
    expect(locateQuote(lines, 'for (let i = 0;   i <= items.length;  i++)')).toMatchObject({
      startLine: 3,
      method: 'normalized',
    });
    expect(locateQuote(lines, 'for (let i = 0; i <= item.length; i++) {')).toMatchObject({
      startLine: 3,
      method: 'fuzzy',
    });
    expect(locateQuote(lines, 'completely unrelated text here')).toBeUndefined();
    expect(locateQuote(lines, '   \n')).toBeUndefined();
  });

  it('picks the match nearest the reported line for duplicate quotes', () => {
    expect(locateQuote(lines, 'let sum = 0;', { nearLine: 11 })?.startLine).toBe(10);
    expect(locateQuote(lines, 'let sum = 0;', { nearLine: 1 })?.startLine).toBe(2);
  });

  it('multi-line quotes, and quotes copied with line numbers or markers', () => {
    expect(locateQuote(lines, 'sum += items[i].price;\n  }\n  return sum;')).toMatchObject({
      startLine: 4,
      endLine: 6,
    });
    expect(locateQuote(lines, '     4 +     sum += items[i].price;')?.startLine).toBe(4);
    expect(locateQuote(lines, '+  return sum;\n+}')).toMatchObject({ startLine: 6, endLine: 7 });
  });

  it('similarity is 1 for equal and low for different strings', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('return sum;', 'throw err;')).toBeLessThan(0.5);
  });
});

describe('validateFindings', () => {
  it('fixes wrong line numbers by re-anchoring the quote', () => {
    const { findings } = run([raw({ startLine: 40, endLine: 41 })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ startLine: 3, endLine: 3, anchor: 'line' });
    expect(findings[0]!.id).toBe(
      fingerprint('src/cart.js', 'bug', 'for (let i = 0; i <= items.length; i++) {'),
    );
  });

  it('re-anchors in CRLF content', () => {
    const file = modified();
    file.newContent = file.newContent!.replace(/\n/g, '\r\n');
    const quote = 'for (let i = 0; i <= items.length; i++) {\r\n    sum += items[i].price;';
    const { findings } = run([raw({ quote, startLine: 1 })], DEFAULT_CONFIG, file);
    expect(findings[0]).toMatchObject({ startLine: 3, endLine: 4 });
  });

  it('drops unanchorable, outside-changed-lines, unknown-file and filtered findings, with counts', () => {
    const { findings, dropped } = run([
      raw({ quote: 'nothing like this exists anywhere' }),
      raw({ quote: 'function avg(items) {', startLine: 9 }), // unchanged line, not next to a deletion
      raw({ file: 'other.js' }),
      raw({ category: 'style' }),
      raw({ severity: 'nit' }),
      raw({ confidence: 0.3 }),
    ]);
    expect(findings).toEqual([]);
    expect(Object.fromEntries(dropped)).toEqual({
      unanchored: 1,
      outsideChangedLines: 1,
      unknownFile: 1,
      categoryDisabled: 1,
      belowSeverity: 1,
      lowConfidence: 1,
    });
  });

  it('prefers the copy of a duplicated quote that is on a changed line', () => {
    // "retry();" is on line 1 (unchanged) and line 5 (added); the model reported line 1.
    const file = parseUnifiedDiff(`--- a/r.js
+++ b/r.js
@@ -3,2 +3,3 @@
 c
 d
+retry();
`).files[0]!;
    file.newContent = 'retry();\nb\nc\nd\nretry();\n';
    const { findings } = run(
      [raw({ file: 'r.js', quote: 'retry();', startLine: 1 })],
      DEFAULT_CONFIG,
      file,
    );
    expect(findings[0]).toMatchObject({ startLine: 5 });
  });

  it('a context line next to a deletion counts as changed', () => {
    const { findings } = run([
      raw({ quote: 'let sum = 0;', startLine: 10, title: 'Removed fallback' }),
    ]);
    expect(findings[0]).toMatchObject({ startLine: 10 });
  });

  it('onlyChangedLines: false keeps findings on context lines', () => {
    const config = { ...DEFAULT_CONFIG, onlyChangedLines: false };
    expect(run([raw({ quote: 'function avg(items) {' })], config).findings).toHaveLength(1);
  });

  it('dedupes overlapping findings of the same category, keeping the most severe', () => {
    const { findings, dropped } = run([
      raw({ severity: 'minor', title: 'a' }),
      raw({ severity: 'critical', title: 'b' }),
      raw({ category: 'performance', title: 'c' }),
    ]);
    expect(findings.map((f) => f.title).sort()).toEqual(['b', 'c']);
    expect(dropped.get('duplicate')).toBe(1);
  });

  it('file-level findings anchor at line 1', () => {
    const { findings } = run([raw({ anchor: 'file', quote: '', category: 'test', startLine: 0 })]);
    expect(findings[0]).toMatchObject({ anchor: 'file', startLine: 1, endLine: 1 });
  });

  it('a file-level finding does not swallow a line finding on line 1', () => {
    const { findings } = run(
      [
        raw({ anchor: 'file', quote: '', category: 'bug', title: 'file-level' }),
        raw({ quote: 'function total(items) {', startLine: 1, title: 'line 1' }),
      ],
      { ...DEFAULT_CONFIG, onlyChangedLines: false },
    );
    expect(findings.map((f) => f.title).sort()).toEqual(['file-level', 'line 1']);
  });

  it('resolves loosely written paths', () => {
    expect(run([raw({ file: 'b/src/cart.js' })]).findings).toHaveLength(1);
    expect(run([raw({ file: './src/cart.js' })]).findings).toHaveLength(1);
    expect(run([raw({ file: 'cart.js' })]).findings).toHaveLength(1);
  });

  it('works without newContent (lines from hunks only)', () => {
    const file = modified();
    delete file.newContent;
    expect(run([raw()], DEFAULT_CONFIG, file).findings[0]).toMatchObject({ startLine: 3 });
  });
});

describe('output parsing', () => {
  it('accepts lenient forms and reports per-item errors', () => {
    const parsed = parseFindingsInput({
      findings: [
        {
          ...raw(),
          severity: 'MAJOR',
          startLine: '3',
          endLine: '2',
          confidence: '0.8',
          suggestion: '',
        },
        { ...raw(), severity: 'urgent' },
      ],
    });
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0]).toMatchObject({
      severity: 'major',
      startLine: 3,
      endLine: 3,
      confidence: 0.8,
    });
    expect(parsed?.findings[0]!.suggestion).toBeUndefined();
    expect(parsed?.errors[0]).toMatch(/findings\[1\].*severity/);
    expect(parseFindingsInput([raw()])?.findings).toHaveLength(1);
    expect(parseFindingsInput('{"findings": []}')).toEqual({ findings: [], errors: [] });
    expect(parseFindingsInput({ nope: 1 })).toBeUndefined();
  });

  it('extracts JSON from fenced or bare text', () => {
    expect(extractJson('Sure:\n```json\n{"findings": []}\n```')).toEqual({ findings: [] });
    expect(extractJson('result {"findings": [1]} done')).toEqual({ findings: [1] });
    expect(extractJson('no json here')).toBeUndefined();
  });
});
