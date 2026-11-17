import type { AgentLimits } from '@ai-review/core';
import type * as vscode from 'vscode';

type Settings = Pick<vscode.WorkspaceConfiguration, 'inspect'>;

/**
 * Settings that decide how much a review may spend. A repository's `.vscode/settings.json`
 * must not change them, or opening a repo could turn off the cost confirmation (raise the
 * threshold, price a model at zero) and spend on the user's API key. They are declared
 * `"scope": "application"` in package.json, and read here from user settings only.
 */
export const USER_ONLY_SETTINGS = [
  'costConfirmationThreshold',
  'anthropic.models',
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

/** Those of `keys` that the workspace or one of its folders sets. */
export function setInWorkspace(settings: Settings, keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const inspected = settings.inspect(key);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  });
}

/** For the cost prompt: the repository's settings picked the provider or model, not the user. */
export function workspaceChoiceNote(keys: readonly string[], modelName: string): string {
  if (!keys.length) return '';
  const names = keys.map((k) => `aiReview.${k}`).join(', ');
  return `${modelName} was chosen by this workspace's settings (${names}).`;
}
