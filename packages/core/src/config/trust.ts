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
}

export interface ResolvedReviewConfig {
  config: ReviewConfig;
  /**
   * How the repository's file makes the review see less than the defaults and the user's
   * own settings would, as user-facing warnings. Pass them as `ReviewOptions.relaxed` so
   * every review result says so.
   */
  relaxed: string[];
}

/**
 * The one place where `.codereview.yml` meets the user's settings (A2). The file comes from
 * the repository, and the change under review can edit it, so it may add scrutiny freely
 * (stricter thresholds, more categories, agentic mode, the verify pass) but not remove it
 * unseen:
 * - higher thresholds and turned-off categories are applied and listed in `relaxed`;
 * - no categories at all is refused (the defaults are used), as no review could report anything;
 * - `ignore:` is reported per review, for the files it left out (`reviewSettingsWarnings`).
 * The user's thresholds can only tighten the result; their mode and verify choices win.
 */
export function resolveReviewConfig(
  repo: ReviewConfig,
  user: UserReviewSettings = {},
): ResolvedReviewConfig {
  const config = applyUserSettings(repo, user);
  const relaxed: string[] = [];

  if (!config.review.categories.length) {
    config.review.categories = [...DEFAULT_CONFIG.review.categories];
    relaxed.push(
      `The repository's ${CONFIG_FILE_NAME} turns off every category; the default categories are reviewed instead.`,
    );
  }
  const off = DEFAULT_CONFIG.review.categories.filter((c) => !config.review.categories.includes(c));
  if (off.length) {
    relaxed.push(
      `The repository's ${CONFIG_FILE_NAME} turns off the ${off.join(', ')} ${off.length === 1 ? 'category' : 'categories'}.`,
    );
  }

  // What the user would see without the repository's file.
  const baseline = applyUserSettings(DEFAULT_CONFIG, user);
  if (severityRank(config.severityThreshold) > severityRank(baseline.severityThreshold)) {
    relaxed.push(
      `The repository's ${CONFIG_FILE_NAME} hides findings below ${config.severityThreshold} severity (instead of below ${baseline.severityThreshold}).`,
    );
  }
  if (config.confidenceThreshold > baseline.confidenceThreshold) {
    relaxed.push(
      `The repository's ${CONFIG_FILE_NAME} hides findings with confidence below ${config.confidenceThreshold} (instead of ${baseline.confidenceThreshold}).`,
    );
  }
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
