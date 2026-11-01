import type { Finding, ParseOutcome } from '@ai-review/core';
import { expectedRange, type ExpectedFinding } from './fixtures';

/** Reported lines may be off by this much and still count as the same location. */
export const LINE_TOLERANCE = 2;

export interface FixtureScore {
  id: string;
  expected: number;
  reported: number;
  /** Expected findings that were found. */
  hits: number;
  /** Reported findings that match an expected one. */
  truePositives: number;
  falsePositives: Finding[];
  misses: ExpectedFinding[];
  nits: number;
  changedLines: number;
  outcomes: ParseOutcome[];
  error?: string;
}

export function matches(finding: Finding, expected: ExpectedFinding): boolean {
  if (finding.file !== expected.file) return false;
  const [start, end] = expectedRange(expected);
  return finding.startLine <= end + LINE_TOLERANCE && start - LINE_TOLERANCE <= finding.endLine;
}

export function scoreFixture(
  id: string,
  expected: ExpectedFinding[],
  findings: Finding[],
  extra: { changedLines: number; outcomes: ParseOutcome[]; error?: string },
): FixtureScore {
  const found = expected.filter((e) => findings.some((f) => matches(f, e)));
  const truePositives = findings.filter((f) => expected.some((e) => matches(f, e)));
  const score: FixtureScore = {
    id,
    expected: expected.length,
    reported: findings.length,
    hits: found.length,
    truePositives: truePositives.length,
    falsePositives: findings.filter((f) => !truePositives.includes(f)),
    misses: expected.filter((e) => !found.includes(e)),
    nits: findings.filter((f) => f.severity === 'nit').length,
    changedLines: extra.changedLines,
    outcomes: extra.outcomes,
  };
  if (extra.error) score.error = extra.error;
  return score;
}

export interface Totals {
  fixtures: number;
  /** Chunks whose output validated on the first or the repair attempt. */
  parseRate: number;
  precision: number;
  recall: number;
  /** Findings on fixtures that expect none. */
  cleanFindings: number;
  nitsPer100Lines: number;
  errors: number;
}

export function totals(scores: FixtureScore[], cleanIds: Set<string>): Totals {
  const outcomes = scores.flatMap((s) => s.outcomes);
  const parsed = outcomes.filter((o) => o === 'valid' || o === 'repaired').length;
  const reported = sum(scores.map((s) => s.reported));
  const expected = sum(scores.map((s) => s.expected));
  const lines = sum(scores.map((s) => s.changedLines));
  return {
    fixtures: scores.length,
    parseRate: outcomes.length ? parsed / outcomes.length : 1,
    precision: reported ? sum(scores.map((s) => s.truePositives)) / reported : 1,
    recall: expected ? sum(scores.map((s) => s.hits)) / expected : 1,
    cleanFindings: sum(scores.filter((s) => cleanIds.has(s.id)).map((s) => s.reported)),
    nitsPer100Lines: lines ? (sum(scores.map((s) => s.nits)) / lines) * 100 : 0,
    errors: scores.filter((s) => s.error).length,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
