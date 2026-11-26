import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  USER_ONLY_SETTINGS,
  agentLimitSettings,
  costThreshold,
  excludeFileGlobs,
  refusalFallback,
  reviewRunSettings,
  setInWorkspace,
  userReviewSettings,
  userSetting,
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
});

describe('settings a repository cannot change (A2)', () => {
  it('lists every setting that changes cost, scrutiny or where the code goes', () => {
    expect([...USER_ONLY_SETTINGS].sort()).toEqual(
      [
        'provider',
        'model',
        'anthropic.models',
        'anthropic.refusalFallback',
        'severityThreshold',
        'confidenceThreshold',
        'allowRepoConfigToRelax',
        'redactHighEntropyStrings',
        'excludeFiles',
        'verifyFindings',
        'incrementalReview',
        'summary',
        'costConfirmationThreshold',
        'reviewMode',
        'includeContext',
        'agent.maxTurns',
        'agent.maxToolCalls',
        'agent.tokenBudget',
      ].sort(),
    );
  });

  it('review mode, verify pass and thresholds ignore workspace and folder values', () => {
    expect(
      userReviewSettings(
        settings({
          reviewMode: { defaultValue: 'auto', workspaceValue: 'agentic' },
          verifyFindings: { defaultValue: 'auto', workspaceFolderValue: 'on' },
          severityThreshold: { defaultValue: '', workspaceValue: 'critical' },
          confidenceThreshold: { defaultValue: 0, workspaceValue: 0.99 },
        }),
      ),
    ).toEqual({ confidenceThreshold: 0 });
    expect(
      userReviewSettings(
        settings({
          reviewMode: {
            defaultValue: 'auto',
            globalValue: 'single-pass',
            workspaceValue: 'agentic',
          },
          verifyFindings: { defaultValue: 'auto', globalValue: 'off', workspaceValue: 'on' },
          severityThreshold: { defaultValue: '', globalValue: 'major', workspaceValue: 'critical' },
          confidenceThreshold: { defaultValue: 0, globalValue: 0.7, workspaceFolderValue: 1 },
        }),
      ),
    ).toEqual({
      mode: 'single-pass',
      verify: false,
      severityThreshold: 'major',
      confidenceThreshold: 0.7,
    });
  });

  it('only the user can let the repository config relax the review', () => {
    expect(
      userReviewSettings(
        settings({
          allowRepoConfigToRelax: {
            defaultValue: false,
            workspaceValue: true,
            workspaceFolderValue: true,
          },
        }),
      ),
    ).toEqual({});
    expect(
      userReviewSettings(
        settings({ allowRepoConfigToRelax: { defaultValue: false, globalValue: true } }),
      ),
    ).toEqual({ allowRepoConfigToRelax: true });
    expect(
      userReviewSettings(settings({ allowRepoConfigToRelax: { globalValue: 'yes' } })),
    ).toEqual({});
  });

  it('"auto" and junk leave mode and verify to the repository', () => {
    expect(
      userReviewSettings(
        settings({
          reviewMode: { globalValue: 'auto' },
          verifyFindings: { globalValue: true },
          severityThreshold: { globalValue: 'bogus' },
          confidenceThreshold: { globalValue: '0.9' },
        }),
      ),
    ).toEqual({});
    expect(userReviewSettings(settings({ verifyFindings: { globalValue: 'on' } }))).toEqual({
      verify: true,
    });
  });

  it('summary, context, incremental reviews and redaction ignore workspace values', () => {
    const defaults = {
      summary: { defaultValue: true },
      includeContext: { defaultValue: true },
      incrementalReview: { defaultValue: true },
      redactHighEntropyStrings: { defaultValue: false },
    };
    expect(
      reviewRunSettings(
        settings({
          summary: { ...defaults.summary, workspaceValue: false },
          includeContext: { ...defaults.includeContext, workspaceFolderValue: false },
          incrementalReview: { ...defaults.incrementalReview, workspaceValue: false },
          redactHighEntropyStrings: {
            defaultValue: false,
            globalValue: true,
            workspaceValue: false,
          },
        }),
      ),
    ).toEqual({ summary: true, includeContext: true, incremental: true, redactHighEntropy: true });
    expect(
      reviewRunSettings(
        settings({
          summary: { ...defaults.summary, globalValue: false },
          includeContext: { ...defaults.includeContext, globalValue: false },
          incrementalReview: { ...defaults.incrementalReview, globalValue: 'no' },
        }),
      ),
    ).toEqual({
      summary: false,
      includeContext: false,
      incremental: true,
      redactHighEntropy: false,
    });
  });

  it('the refusal fallback ignores workspace values', () => {
    const key = 'anthropic.refusalFallback';
    expect(
      refusalFallback(settings({ [key]: { defaultValue: true, workspaceValue: false } })),
    ).toBe(true);
    expect(
      refusalFallback(
        settings({ [key]: { defaultValue: true, globalValue: false, workspaceValue: true } }),
      ),
    ).toBe(false);
    expect(refusalFallback(settings({}))).toBe(true);
  });

  it('the excluded files come from user settings only, and junk entries are dropped', () => {
    const key = 'excludeFiles';
    // A workspace can't replace the user's list with an empty one.
    expect(
      excludeFileGlobs(
        settings({ [key]: { defaultValue: [], globalValue: ['/deals/**'], workspaceValue: [] } }),
      ),
    ).toEqual(['/deals/**']);
    expect(
      excludeFileGlobs(settings({ [key]: { defaultValue: [], workspaceValue: ['x'] } })),
    ).toEqual([]);
    expect(
      excludeFileGlobs(settings({ [key]: { globalValue: ['*.cfg', 3, '', '  ', null] } })),
    ).toEqual(['*.cfg']);
    expect(excludeFileGlobs(settings({ [key]: { globalValue: 'secrets.json' } }))).toEqual([]);
    expect(excludeFileGlobs(settings({}))).toEqual([]);
  });
});
