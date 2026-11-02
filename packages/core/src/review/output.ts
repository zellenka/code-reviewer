import { z } from 'zod';
import { CATEGORIES, SEVERITIES } from '../config/schema';
import type { ToolDef } from '../provider/types';
import type { RawFinding } from './types';

export const REPORT_TOOL_NAME = 'report_findings';

/** JSON schema the model sees. Kept by hand (short, provider-friendly); zod below validates it. */
export const REPORT_FINDINGS_TOOL: ToolDef = {
  name: REPORT_TOOL_NAME,
  description:
    'Report all review findings for the diff in one call. Call it exactly once; use an empty list when there are no real issues.',
  inputSchema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'File path exactly as in the <file path="…"> tag.',
            },
            startLine: {
              type: 'integer',
              description: 'First new-side line number (left column of the diff).',
            },
            endLine: { type: 'integer', description: 'Last new-side line number (inclusive).' },
            anchor: {
              type: 'string',
              enum: ['line', 'file'],
              description: '"file" for whole-file findings (e.g. missing tests). Default "line".',
            },
            severity: { type: 'string', enum: [...SEVERITIES] },
            category: { type: 'string', enum: [...CATEGORIES] },
            title: { type: 'string', description: 'One short sentence.' },
            body: {
              type: 'string',
              description: 'Markdown: what is wrong, why it matters, how to fix it.',
            },
            quote: {
              type: 'string',
              description:
                'Exact code from the new side that the finding is about, copied without line numbers or +/- markers. One or a few lines.',
            },
            suggestion: {
              type: 'string',
              description: 'Optional replacement code for exactly the quoted code.',
            },
            confidence: {
              type: 'number',
              description: 'How sure you are this is a real issue, 0..1.',
            },
          },
          required: [
            'file',
            'startLine',
            'endLine',
            'severity',
            'category',
            'title',
            'body',
            'quote',
            'confidence',
          ],
        },
      },
    },
    required: ['findings'],
  },
};

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const num = (v: unknown) =>
  typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
const line = z.preprocess(num, z.number().int().min(0));
const emptyToUndefined = (v: unknown) =>
  v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v;

/** Lenient on form (string numbers, case), strict on meaning. */
export const rawFindingSchema = z.object({
  file: z.string().min(1),
  startLine: line,
  endLine: line,
  anchor: z.preprocess(emptyToUndefined, z.preprocess(lower, z.enum(['line', 'file'])).optional()),
  severity: z.preprocess(lower, z.enum(SEVERITIES)),
  category: z.preprocess(lower, z.enum(CATEGORIES)),
  title: z.string().min(1),
  body: z.string(),
  quote: z.string(),
  suggestion: z.preprocess(emptyToUndefined, z.string().optional()),
  confidence: z.preprocess(num, z.number().min(0).max(1)),
});

export interface ParsedFindings {
  findings: RawFinding[];
  /** One message per invalid finding (index + problem). */
  errors: string[];
}

/**
 * Validates tool input (or parsed JSON). Accepts `{findings: [...]}` or a bare array.
 * Returns undefined when the shape is unusable as a whole.
 */
export function parseFindingsInput(input: unknown): ParsedFindings | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const list = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        Array.isArray((value as { findings?: unknown }).findings)
      ? (value as { findings: unknown[] }).findings
      : undefined;
  if (!list) return undefined;

  const findings: RawFinding[] = [];
  const errors: string[] = [];
  list.forEach((item, i) => {
    const parsed = rawFindingSchema.safeParse(item);
    if (parsed.success) {
      const f = parsed.data;
      const finding: RawFinding = {
        file: f.file,
        startLine: f.startLine,
        endLine: Math.max(f.startLine, f.endLine),
        severity: f.severity,
        category: f.category,
        title: f.title.trim(),
        body: f.body.trim(),
        quote: f.quote,
        confidence: f.confidence,
      };
      if (f.anchor) finding.anchor = f.anchor;
      if (f.suggestion !== undefined) finding.suggestion = f.suggestion;
      findings.push(finding);
    } else {
      const issues = parsed.error.issues
        .map((iss) => `${iss.path.join('.') || 'item'}: ${iss.message}`)
        .join('; ');
      errors.push(`findings[${i}]: ${issues}`);
    }
  });
  return { findings, errors };
}

/**
 * Fallback for replies without a tool call: the last ```json fenced block,
 * else the outermost {...} or [...] in the text.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const fence of fences.reverse()) {
    try {
      return JSON.parse(fence[1]!);
    } catch {
      // try the next one
    }
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // not JSON
      }
    }
  }
  return undefined;
}
