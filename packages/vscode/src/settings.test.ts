import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  agentLimitSettings,
  costThreshold,
  setInWorkspace,
  userSetting,
  workspaceChoiceNote,
} from './settings';

interface Values {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** Settings as VS Code merges them: folder, then workspace, then user, then default. */
function settings(
  values: Record<string, Values>,
): Pick<vscode.WorkspaceConfiguration, 'get' | 'inspect'> {
  const inspect = (key: string) => (values[key] ? { key, ...values[key] } : undefined);
  return {
    inspect: inspect as vscode.WorkspaceConfiguration['inspect'],
    get: ((key: string, fallback?: unknown) => {
      const v = values[key] ?? {};
      return (
        v.workspaceFolderValue ?? v.workspaceValue ?? v.globalValue ?? v.defaultValue ?? fallback
      );
    }) as vscode.WorkspaceConfiguration['get'],
  };
}

describe('user-only settings (F23)', () => {
  it('the cost threshold ignores workspace and folder values', () => {
    expect(
      costThreshold(
        settings({ costConfirmationThreshold: { defaultValue: 0.5, workspaceValue: 1000 } }),
      ),
    ).toBe(0.5);
    expect(
      costThreshold(
        settings({
          costConfirmationThreshold: {
            defaultValue: 0.5,
            globalValue: 2,
            workspaceFolderValue: 1e9,
          },
        }),
      ),
    ).toBe(2);
  });

  it('the cost threshold honours the user value, and an invalid one falls back to the default', () => {
    expect(costThreshold(settings({ costConfirmationThreshold: { globalValue: 0 } }))).toBe(0);
    expect(costThreshold(settings({}))).toBe(0.5);
    for (const bad of ['1000', -1, Number.NaN, null]) {
      expect(costThreshold(settings({ costConfirmationThreshold: { globalValue: bad } }))).toBe(
        0.5,
      );
    }
  });

  it('model overrides (pricing) come from user settings only', () => {
    const free = [{ id: 'claude-opus-4-1', pricing: { inputPerMTok: 0, outputPerMTok: 0 } }];
    const mine = [{ id: 'mine' }];
    expect(
      userSetting(
        settings({ 'anthropic.models': { defaultValue: [], workspaceValue: free } }),
        'anthropic.models',
      ),
    ).toEqual([]);
    expect(
      userSetting(
        settings({
          'anthropic.models': { defaultValue: [], globalValue: mine, workspaceFolderValue: free },
        }),
        'anthropic.models',
      ),
    ).toEqual(mine);
  });

  it('agent limits ignore workspace values and honour user values', () => {
    expect(
      agentLimitSettings(
        settings({
          'agent.tokenBudget': { defaultValue: 200_000, workspaceValue: 1_000_000 },
          'agent.maxTurns': { defaultValue: 8, globalValue: 12, workspaceValue: 30 },
          'agent.maxToolCalls': { defaultValue: 20, workspaceFolderValue: 100 },
        }),
      ),
    ).toEqual({ tokenBudget: 200_000, maxTurns: 12, maxToolCalls: 20 });
  });

  it('agent limits are clamped to the documented range', () => {
    expect(
      agentLimitSettings(
        settings({
          'agent.tokenBudget': { globalValue: 50_000_000 },
          'agent.maxTurns': { globalValue: 500 },
          'agent.maxToolCalls': { globalValue: Number.POSITIVE_INFINITY },
        }),
      ),
    ).toEqual({ tokenBudget: 2_000_000, maxTurns: 30, maxToolCalls: 100 });
    expect(agentLimitSettings(settings({ 'agent.tokenBudget': { globalValue: 1_000 } }))).toEqual({
      tokenBudget: 20_000,
    });
    // Zero, negative or non-numbers: the engine's defaults.
    expect(
      agentLimitSettings(
        settings({
          'agent.tokenBudget': { globalValue: 0 },
          'agent.maxTurns': { globalValue: -3 },
          'agent.maxToolCalls': { globalValue: '50' },
        }),
      ),
    ).toEqual({});
  });

  it('lists the settings a workspace or folder sets', () => {
    const s = settings({
      provider: { defaultValue: 'copilot', workspaceValue: 'anthropic' },
      model: { defaultValue: '', workspaceFolderValue: 'claude-opus-4-1' },
      costConfirmationThreshold: { globalValue: 1 },
    });
    expect(setInWorkspace(s, ['provider', 'model', 'costConfirmationThreshold'])).toEqual([
      'provider',
      'model',
    ]);
  });

  it('says when the workspace picked the model', () => {
    expect(workspaceChoiceNote([], 'Opus')).toBe('');
    expect(workspaceChoiceNote(['provider', 'model'], 'Claude Opus')).toBe(
      "Claude Opus was chosen by this workspace's settings (aiReview.provider, aiReview.model).",
    );
  });
});
