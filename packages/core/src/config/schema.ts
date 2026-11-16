import { z } from 'zod';

export const SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'style',
  'test',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const REVIEW_MODES = ['single-pass', 'agentic'] as const;

/** Higher = more severe. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(severity);
}

/** The settings a `.codereview.yml` controls: *what* is reviewed and reported. */
export interface ReviewConfig {
  version: 1;
  severityThreshold: Severity;
  confidenceThreshold: number;
  onlyChangedLines: boolean;
  ignore: string[];
  rules?: string;
  language: string;
  review: {
    mode: (typeof REVIEW_MODES)[number];
    categories: Category[];
    /** Second opinion on each finding before it is shown (P5-2). */
    verify: boolean;
  };
}

export const DEFAULT_CONFIG: ReviewConfig = {
  version: 1,
  severityThreshold: 'minor',
  confidenceThreshold: 0.6,
  onlyChangedLines: true,
  ignore: [],
  language: 'en',
  review: {
    mode: 'single-pass',
    categories: ['bug', 'security', 'performance', 'maintainability', 'test'],
    verify: false,
  },
};

/**
 * `language` goes into the prompts as is, so it may only be a language name or tag
 * ("en", "pt-BR", "Simplified Chinese"): letters in any script, single spaces or hyphens
 * between words, at most 40 characters. Anything else could carry instructions.
 */
const LANGUAGE_PATTERN = /^(?=.{1,40}$)[\p{L}\p{M}]+(?:[ -][\p{L}\p{M}]+)*$/u;
/** `rules` is named in the prompt (`<repo_rules source="…">`): no tags, quotes or line breaks. */
const RULES_PATH_PATTERN = /^[^\p{Cc}<>"]+$/u;

/** Every field is optional; missing ones fall back to `DEFAULT_CONFIG`. */
export const configFileSchema = z
  .object({
    version: z.literal(1).optional(),
    severityThreshold: z.enum(SEVERITIES).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    onlyChangedLines: z.boolean().optional(),
    ignore: z.array(z.string().min(1)).optional(),
    rules: z
      .string()
      .regex(RULES_PATH_PATTERN, 'must be a file path without line breaks, quotes, < or >')
      .optional(),
    language: z
      .string()
      .regex(
        LANGUAGE_PATTERN,
        'must be a language name or tag such as "en" or "pt-BR" (letters, spaces and hyphens, at most 40 characters)',
      )
      .optional(),
    review: z
      .object({
        mode: z.enum(REVIEW_MODES).optional(),
        categories: z.array(z.enum(CATEGORIES)).optional(),
        verify: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
