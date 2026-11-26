import {
  SEVERITIES,
  type AgentLimits,
  type Severity,
  type UserReviewSettings,
} from '@ai-review/core';
import type * as vscode from 'vscode';

type Settings = Pick<vscode.WorkspaceConfiguration, 'inspect'>;

/**
 * Settings a repository's `.vscode/settings.json` must not change (F23, A2): those that
 * decide how much a review may spend (cost threshold, prices, agent limits, the summary,
 * verify and refusal-fallback requests, full re-reviews), how closely it looks (thresholds,
 * mode, context, the verify pass that drops findings, whether `.codereview.yml` may relax
 * the review) and where the code goes (provider,
 * model, fallback model, what is redacted). Opening a repository must not, for example,
 * turn off the cost confirmation or pick an expensive model on the user's API key. They are
 * declared `"scope": "application"` in package.json, and read here from user settings only.
 * What a repository may decide goes in `.codereview.yml`, checked by `resolveReviewConfig`.
 */
export const USER_ONLY_SETTINGS = [
  'provider',
  'model',
  'anthropic.models',
  'anthropic.refusalFallback',
  'severityThreshold',
  'confidenceThreshold',
  'allowRepoConfigToRelax',
  'redactHighEntropyStrings',
  'verifyFindings',
  'incrementalReview',
  'summary',
  'costConfirmationThreshold',
  'reviewMode',
  'includeContext',
  'agent.maxTurns',
  'agent.maxToolCalls',
  'agent.tokenBudget',
] as const;

/** Keep in sync with `minimum`/`maximum` in package.json (checked by an extension test). */
export const AGENT_LIMIT_SETTINGS = {
  maxTurns: { key: 'agent.maxTurns', min: 1, max: 30 },
  maxToolCalls: { key: 'agent.maxToolCalls', min: 1, max: 100 },
  tokenBudget: { key: 'agent.tokenBudget', min: 20_000, max: 2_000_000 },
} as const;

export const DEFAULT_COST_THRESHOLD = 0.5;

/** The user's value, else the default. Workspace and folder values are ignored. */
export function userSetting<T>(settings: Settings, key: string): T | undefined {
  const inspected = settings.inspect<T>(key);
  return inspected?.globalValue ?? inspected?.defaultValue;
}

/** `aiReview.costConfirmationThreshold` in USD; an invalid value means the default. */
export function costThreshold(settings: Settings): number {
  const value = userSetting<unknown>(settings, 'costConfirmationThreshold');
  return typeof value === 'number' && value >= 0 ? value : DEFAULT_COST_THRESHOLD;
}

/** Agent limits set by the user, clamped to their documented range. Others use the engine's defaults. */
export function agentLimitSettings(settings: Settings): Partial<AgentLimits> {
  const limits: Partial<AgentLimits> = {};
  for (const [name, { key, min, max }] of Object.entries(AGENT_LIMIT_SETTINGS)) {
    const value = userSetting<unknown>(settings, key);
    if (typeof value === 'number' && value > 0) {
      limits[name as keyof typeof AGENT_LIMIT_SETTINGS] = Math.min(max, Math.max(min, value));
    }
  }
  return limits;
}

/** The user's settings that `resolveReviewConfig` merges with the repository's config. */
export function userReviewSettings(settings: Settings): UserReviewSettings {
  const severity = userSetting<unknown>(settings, 'severityThreshold');
  const confidence = userSetting<unknown>(settings, 'confidenceThreshold');
  const mode = userSetting<unknown>(settings, 'reviewMode');
  const verify = userSetting<unknown>(settings, 'verifyFindings');
  const relax = userSetting<unknown>(settings, 'allowRepoConfigToRelax');
  return {
    ...(SEVERITIES.includes(severity as Severity)
      ? { severityThreshold: severity as Severity }
      : {}),
    ...(typeof confidence === 'number' ? { confidenceThreshold: confidence } : {}),
    // "auto" leaves `review.mode` and `review.verify` to the repository.
    ...(mode === 'single-pass' || mode === 'agentic' ? { mode } : {}),
    ...(verify === 'on' || verify === 'off' ? { verify: verify === 'on' } : {}),
    ...(relax === true ? { allowRepoConfigToRelax: true } : {}),
  };
}

/** The user's switches for how a review runs; a missing or invalid value means the default. */
export function reviewRunSettings(settings: Settings): {
  includeContext: boolean;
  summary: boolean;
  incremental: boolean;
  redactHighEntropy: boolean;
} {
  const flag = (key: string, fallback: boolean) => {
    const value = userSetting<unknown>(settings, key);
    return typeof value === 'boolean' ? value : fallback;
  };
  return {
    includeContext: flag('includeContext', true),
    summary: flag('summary', true),
    incremental: flag('incrementalReview', true),
    redactHighEntropy: flag('redactHighEntropyStrings', false),
  };
}

/** `aiReview.anthropic.refusalFallback`: on unless the user turned it off. */
export function refusalFallback(settings: Settings): boolean {
  return userSetting<unknown>(settings, 'anthropic.refusalFallback') !== false;
}

/** Those of `keys` that the workspace or one of its folders sets. */
export function setInWorkspace(settings: Settings, keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const inspected = settings.inspect(key);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  });
}
