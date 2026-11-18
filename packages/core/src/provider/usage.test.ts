import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToTokens } from './usage';

describe('estimateTokens', () => {
  it('counts ASCII text at 3.5 characters per token, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('x'.repeat(7))).toBe(2);
    expect(estimateTokens('x'.repeat(8))).toBe(3);
    expect(estimateTokens('x'.repeat(3_500))).toBe(1_000);
    expect(estimateTokens('const a = 1;\n'.repeat(100))).toBe(Math.ceil(1_300 / 3.5));
  });

  it('counts CJK and other wide characters as a token each', () => {
    // A tokenizer gives each of these about one token, not one per 3.5 characters.
    expect(estimateTokens('漢'.repeat(1_000))).toBe(1_000);
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('한국어')).toBe(3);
  });

  it('counts a character outside the BMP once, not once per UTF-16 half', () => {
    expect('😀'.length).toBe(2);
    expect(estimateTokens('😀'.repeat(10))).toBe(10);
    expect(estimateTokens('𠀀'.repeat(10))).toBe(10); // CJK Extension B
  });

  it('counts Cyrillic, Greek and accented Latin at two characters per token', () => {
    expect(estimateTokens('привіт'.repeat(100))).toBe(300);
    expect(estimateTokens('αβγδ')).toBe(2);
    expect(estimateTokens('é')).toBe(1);
  });

  it('adds up mixed text', () => {
    // 7 ASCII (2 tokens) + 2 CJK (2) + 2 Cyrillic (1).
    expect(estimateTokens('abcdefg漢字пр')).toBe(5);
    // A comment in Chinese (9 characters) inside code.
    const line = '// 计算总价并返回结果\nconst total = sum(items);\n';
    expect(estimateTokens(line)).toBe(Math.ceil((line.length - 9) / 3.5 + 9));
  });

  it('counts a lone surrogate as a character', () => {
    expect(estimateTokens('\ud800')).toBe(1);
    expect(estimateTokens('\udc00\udc00')).toBe(2);
  });
});

describe('truncateToTokens', () => {
  it('keeps text that fits', () => {
    expect(truncateToTokens('hello', 10)).toBe('hello');
    expect(truncateToTokens('', 0)).toBe('');
  });

  it('cuts ASCII at 3.5 characters per token', () => {
    expect(truncateToTokens('x'.repeat(10_000), 1_000)).toBe('x'.repeat(3_500));
  });

  it('cuts wide text so the result fits the budget', () => {
    const cut = truncateToTokens('漢'.repeat(10_000), 1_000);
    expect(cut).toBe('漢'.repeat(1_000));
    expect(estimateTokens(cut)).toBe(1_000);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateToTokens('a😀😀😀', 2);
    expect(cut).toBe('a😀');
    expect(estimateTokens(cut)).toBeLessThanOrEqual(2);
  });

  it('returns the longest prefix within the budget for mixed text', () => {
    const text = 'ab漢cd😀ef пр gh'.repeat(50);
    for (const budget of [0, 1, 5, 17, 100, 333]) {
      const cut = truncateToTokens(text, budget);
      expect(text.startsWith(cut)).toBe(true);
      expect(estimateTokens(cut)).toBeLessThanOrEqual(budget);
      if (cut.length < text.length) {
        expect(estimateTokens(text.slice(0, cut.length + 1))).toBeGreaterThan(budget);
      }
    }
  });
});
