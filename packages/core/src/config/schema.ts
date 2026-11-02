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
  },
};

/** Every field is optional; missing ones fall back to `DEFAULT_CONFIG`. */
export const configFileSchema = z
  .object({
    version: z.literal(1).optional(),
    severityThreshold: z.enum(SEVERITIES).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    onlyChangedLines: z.boolean().optional(),
    ignore: z.array(z.string().min(1)).optional(),
    rules: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
    review: z
      .object({
        mode: z.enum(REVIEW_MODES).optional(),
        categories: z.array(z.enum(CATEGORIES)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
