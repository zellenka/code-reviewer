import { describe, expect, it } from 'vitest';
import { locateQuote } from '@ai-review/core';
import { expectedRange, loadFixtures } from './fixtures';
import { matches, scoreFixture, totals } from './score';

describe('eval fixtures', async () => {
  const fixtures = await loadFixtures();

  it('has 20–30 fixtures covering clean, cross-file and CRLF cases', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(fixtures.length).toBeLessThanOrEqual(30);
    expect(
      fixtures.filter((f) => f.expected.some((e) => e.crossFile)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(fixtures.filter((f) => f.expected.length === 0).length).toBeGreaterThanOrEqual(3);
    expect(fixtures.some((f) => f.eol === 'crlf' && f.expected.length > 0)).toBe(true);
    expect(fixtures.some((f) => f.eol === 'crlf' && f.expected.length === 0)).toBe(true);
  });

  for (const fixture of fixtures) {
    it(`${fixture.id}: every expected quote is at its stated lines`, () => {
      for (const e of fixture.expected) {
        const content = fixture.after[e.file];
        expect(content, `${e.file} missing from after`).toBeDefined();
        const match = locateQuote(content!.split('\n'), e.quote);
        expect(match?.method, e.quote).toBe('exact');
        const [start, end] = expectedRange(e);
        expect(match!.startLine).toBeGreaterThanOrEqual(start);
        expect(match!.endLine).toBeLessThanOrEqual(end);
      }
    });
  }
});

describe('scoring', () => {
  const expected = [
    {
      file: 'a.ts',
      lines: 10,
      category: 'bug',
      severity: 'major',
      title: 't',
      quote: 'q',
      crossFile: false,
    } as const,
  ];
  const finding = (file: string, line: number) => ({
    id: String(line),
    file,
    startLine: line,
    endLine: line,
    anchor: 'line' as const,
    severity: 'nit' as const,
    category: 'bug' as const,
    title: 't',
    body: '',
    quote: 'q',
    confidence: 1,
  });

  it('matches by file and overlapping lines with tolerance', () => {
    expect(matches(finding('a.ts', 12), expected[0]!)).toBe(true);
    expect(matches(finding('a.ts', 13), expected[0]!)).toBe(false);
    expect(matches(finding('b.ts', 10), expected[0]!)).toBe(false);
  });

  it('requires an accepted category', () => {
    const security = { ...finding('a.ts', 10), category: 'security' as const };
    expect(matches(security, expected[0]!)).toBe(false);
    expect(matches(security, { ...expected[0]!, category: ['security', 'bug'] })).toBe(true);
  });

  it('computes precision, recall, clean findings and nit rate', () => {
    const s1 = scoreFixture('one', [...expected], [finding('a.ts', 10), finding('a.ts', 40)], {
      changedLines: 100,
      outcomes: ['valid'],
    });
    const s2 = scoreFixture('clean', [], [finding('c.ts', 1)], {
      changedLines: 100,
      outcomes: ['repaired', 'failed'],
    });
    const t = totals([s1, s2], new Set(['clean']));
    expect(t.precision).toBeCloseTo(1 / 3);
    expect(t.recall).toBe(1);
    expect(t.cleanFindings).toBe(1);
    expect(t.parseRate).toBeCloseTo(2 / 3);
    expect(t.nitsPer100Lines).toBeCloseTo(1.5);
  });
});
