import { CONFIG_FILE_NAME } from './load';
import {
  DEFAULT_CONFIG,
  REVIEW_MODES,
  SEVERITIES,
  severityRank,
  type ReviewConfig,
  type Severity,
} from './schema';

/**
 * The user's own settings that take part in a review's config. Hosts read them from the
 * user's settings only, never from the repository (in VS Code they are user-scoped).
 */
export interface UserReviewSettings {
  /** Can only make the repository's threshold stricter. */
  severityThreshold?: Severity;
  /** Can only make the repository's threshold stricter. */
  confidenceThreshold?: number;
  /** Overrides `review.mode`. */
  mode?: ReviewConfig['review']['mode'];
  /** Overrides `review.verify`. */
  verify?: boolean;
  /**
   * The repository's file may also make the review see less (for repositories the user
   * trusts). It is then applied, with a warning, instead of refused.
   */
  allowRepoConfigToRelax?: boolean;
}

export interface ResolvedReviewConfig {
  config: ReviewConfig;
  /**
   * How the repository's file would make the review see less than the defaults and the
   * user's own settings, and whether that was applied, as user-facing warnings. Pass them
   * as `ReviewOptions.relaxed` so every review result says so.
   */
  relaxed: string[];
}

/**
 * The one place where `.codereview.yml` meets the user's settings (A2). The file comes from
 * the repository, and the change under review can edit it, so it can only tighten the
 * review: it may add scrutiny freely (stricter thresholds, more categories, agentic mode,
 * the verify pass), but what would remove some is not applied, and `relaxed` says so:
 * - higher thresholds than the defaults and the user's own: the baseline is kept;
 * - turned-off default categories: they are reviewed (added ones are kept);
 * - `ignore:` skips only generated, vendored and lock files (`filterFiles`); the other
 *   files it matches are reviewed and named per review (`reviewSettingsWarnings`);
 * - no categories at all: refused (the defaults are used).
 * With `user.allowRepoConfigToRelax` all of it is applied instead (but no categories at
 * all), still with the warnings. The user's thresholds can only tighten the result; their
 * mode and verify choices win.
 */
export function resolveReviewConfig(
  repo: ReviewConfig,
  user: UserReviewSettings = {},
): ResolvedReviewConfig {
  const allow = user.allowRepoConfigToRelax === true;
  const config = applyUserSettings(repo, user);
  const relaxed: string[] = [];
  /** One warning: `applied` when it is, else `refused` ("would …"). */
  const warn = (applied: string, refused: string) =>
    relaxed.push(
      allow
        ? `The repository's ${CONFIG_FILE_NAME} ${applied}.`
        : `Not applied: the repository's ${CONFIG_FILE_NAME} ${refused}.`,
    );

  if (!config.review.categories.length) {
    config.review.categories = [...DEFAULT_CONFIG.review.categories];
    relaxed.push(
      `The repository's ${CONFIG_FILE_NAME} turns off every category; the default categories are reviewed instead.`,
    );
  }
  const off = DEFAULT_CONFIG.review.categories.filter((c) => !config.review.categories.includes(c));
  if (off.length) {
    const categories = `the ${off.join(', ')} ${off.length === 1 ? 'category' : 'categories'}`;
    warn(`turns off ${categories}`, `would turn off ${categories}`);
    if (!allow) config.review.categories.push(...off);
  }

  // What the user would see without the repository's file.
  const baseline = applyUserSettings(DEFAULT_CONFIG, user);
  if (severityRank(config.severityThreshold) > severityRank(baseline.severityThreshold)) {
    const what = `findings below ${config.severityThreshold} severity (instead of below ${baseline.severityThreshold})`;
    warn(`hides ${what}`, `would hide ${what}`);
    if (!allow) config.severityThreshold = baseline.severityThreshold;
  }
  if (config.confidenceThreshold > baseline.confidenceThreshold) {
    const what = `findings with confidence below ${config.confidenceThreshold} (instead of ${baseline.confidenceThreshold})`;
    warn(`hides ${what}`, `would hide ${what}`);
    if (!allow) config.confidenceThreshold = baseline.confidenceThreshold;
  }

  // Only set when it changes something, so the setting alone keeps the snapshot key.
  delete config.ignoreAnyFile;
  if (allow && config.ignore.length) config.ignoreAnyFile = true;
  return { config, relaxed };
}

function applyUserSettings(config: ReviewConfig, user: UserReviewSettings): ReviewConfig {
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
  if (user.mode && REVIEW_MODES.includes(user.mode)) result.review.mode = user.mode;
  if (typeof user.verify === 'boolean') result.review.verify = user.verify;
  return result;
}
