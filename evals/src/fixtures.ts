import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { CATEGORIES, SEVERITIES } from '@ai-review/core';
import { parse } from 'yaml';
import { z } from 'zod';

const expectedSchema = z.object({
  file: z.string(),
  /** New-side line, or [start, end]. */
  lines: z.union([z.number().int(), z.tuple([z.number().int(), z.number().int()])]),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  /** Exact new-side code; the mock provider reports it. */
  quote: z.string(),
});

const fixtureSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Committed first. */
  before: z.record(z.string(), z.string()).default({}),
  /** Written to the working tree afterwards (reviewed as unstaged changes). */
  after: z.record(z.string(), z.string()),
  /** Empty = clean fixture: any finding is a false positive. */
  expected: z.array(expectedSchema).default([]),
});

export type ExpectedFinding = z.infer<typeof expectedSchema>;
export type Fixture = z.infer<typeof fixtureSchema> & { id: string };

export const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

export async function loadFixtures(dir = FIXTURES_DIR, filter?: string): Promise<Fixture[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.yml')).sort();
  const fixtures: Fixture[] = [];
  for (const name of names) {
    const id = name.replace(/\.yml$/, '');
    if (filter && !id.includes(filter)) continue;
    const parsed = fixtureSchema.safeParse(parse(await readFile(path.join(dir, name), 'utf8')));
    if (!parsed.success) {
      throw new Error(
        `${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    fixtures.push({ ...parsed.data, id });
  }
  return fixtures;
}

export function expectedRange(e: ExpectedFinding): [number, number] {
  return typeof e.lines === 'number' ? [e.lines, e.lines] : e.lines;
}
