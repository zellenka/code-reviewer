import { parseDocument } from 'yaml';
import type { z } from 'zod';
import {
  DEFAULT_CONFIG,
  SEVERITIES,
  configFileSchema,
  severityRank,
  type ConfigFile,
  type ReviewConfig,
  type Severity,
} from './schema';

export const CONFIG_FILE_NAME = '.codereview.yml';

export interface ConfigLoadResult {
  config: ReviewConfig;
  /** Human-readable problems. When non-empty the bad fields fell back to defaults. */
  warnings: string[];
}

/**
 * Parses `.codereview.yml` text. Never throws: syntax errors give defaults + a warning,
 * invalid fields are dropped one by one (the valid ones are kept).
 */
export function parseConfig(text: string | undefined, source = CONFIG_FILE_NAME): ConfigLoadResult {
  if (text === undefined || text.trim() === '') return { config: cloneDefaults(), warnings: [] };

  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) {
    return {
      config: cloneDefaults(),
      warnings: [`${source}: invalid YAML (${doc.errors[0]!.message}). Using defaults.`],
    };
  }
  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined) return { config: cloneDefaults(), warnings: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: cloneDefaults(),
      warnings: [`${source}: expected a mapping at the top level. Using defaults.`],
    };
  }

  const parsed = configFileSchema.safeParse(raw);
  if (parsed.success) return { config: applyFile(parsed.data), warnings: [] };

  // Drop each invalid field and keep the rest.
  const warnings = parsed.error.issues.map((issue) => `${source}: ${describeIssue(issue)}`);
  const cleaned = structuredClone(raw) as Record<string, unknown>;
  for (const issue of parsed.error.issues) removeIssuePath(cleaned, issue);
  const retry = configFileSchema.safeParse(cleaned);
  const config = retry.success ? applyFile(retry.data) : cloneDefaults();
  return { config, warnings: [...warnings.map((w) => `${w} (ignored)`)] };
}

/**
 * User/VS Code settings that may tighten the repo config, never loosen it.
 * The repo decides what is reported; a user can only see less.
 */
export interface UserThresholds {
  severityThreshold?: Severity;
  confidenceThreshold?: number;
}

export function applyUserThresholds(config: ReviewConfig, user: UserThresholds): ReviewConfig {
  const result = structuredClone(config);
  if (user.severityThreshold && SEVERITIES.includes(user.severityThreshold)) {
    if (severityRank(user.severityThreshold) > severityRank(result.severityThreshold)) {
      result.severityThreshold = user.severityThreshold;
    }
  }
  if (
    typeof user.confidenceThreshold === 'number' &&
    Number.isFinite(user.confidenceThreshold) &&
    user.confidenceThreshold <= 1
  ) {
    result.confidenceThreshold = Math.max(result.confidenceThreshold, user.confidenceThreshold);
  }
  return result;
}

function applyFile(file: ConfigFile): ReviewConfig {
  const config = cloneDefaults();
  if (file.severityThreshold) config.severityThreshold = file.severityThreshold;
  if (file.confidenceThreshold !== undefined) config.confidenceThreshold = file.confidenceThreshold;
  if (file.onlyChangedLines !== undefined) config.onlyChangedLines = file.onlyChangedLines;
  if (file.ignore) config.ignore = [...file.ignore];
  if (file.rules) config.rules = file.rules;
  if (file.language) config.language = file.language;
  if (file.review?.mode) config.review.mode = file.review.mode;
  if (file.review?.categories) config.review.categories = [...new Set(file.review.categories)];
  return config;
}

function cloneDefaults(): ReviewConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.') || '(root)';
  if (issue.code === 'unrecognized_keys') return `unknown key(s) ${issue.keys.join(', ')}`;
  return `${path}: ${issue.message}`;
}

/** Deletes the top-level or nested field an issue points at (or the unknown keys). */
function removeIssuePath(obj: Record<string, unknown>, issue: z.core.$ZodIssue): void {
  const path = [...issue.path];
  let target: unknown = obj;
  if (issue.code === 'unrecognized_keys') {
    for (const key of path) target = (target as Record<PropertyKey, unknown>)?.[key as PropertyKey];
    if (target && typeof target === 'object') {
      for (const key of issue.keys) delete (target as Record<string, unknown>)[key];
    }
    return;
  }
  // Remove the whole field at depth ≤ 2 (e.g. `review.categories`, not one array item).
  const fieldPath = path.slice(0, path[0] === 'review' ? 2 : 1);
  const last = fieldPath.pop();
  for (const key of fieldPath)
    target = (target as Record<PropertyKey, unknown>)?.[key as PropertyKey];
  if (target && typeof target === 'object' && last !== undefined) {
    delete (target as Record<PropertyKey, unknown>)[last as PropertyKey];
  }
}
