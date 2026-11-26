import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  ContentExclusion,
  copilotExclusionCheck,
  excludeFilesMatcher,
  type CopilotAnswer,
  type CopilotEnv,
  type CopilotExclusionCheck,
} from './exclusion';

const signal = () => new AbortController().signal;

describe('aiReview.excludeFiles patterns', () => {
  it('match like GitHub content exclusion paths', () => {
    const excluded = excludeFilesMatcher([
      '/scripts/***',
      'secrets.json',
      '*.cfg',
      '/src/internal',
      'docs/private/',
    ]);
    for (const p of [
      'scripts/build.sh',
      'scripts/ci/deploy.sh',
      'secrets.json',
      'app/config/secrets.json',
      'server.cfg',
      'deep/dir/app.cfg',
      // A matched folder excludes everything in it.
      'src/internal/acme.ts',
      'src/internal',
      'docs/private/plan.md',
      // Letter case is ignored.
      'Scripts/Build.sh',
      'APP/SECRETS.JSON',
    ]) {
      expect(excluded(p), p).toBe(true);
    }
    for (const p of [
      'src/scripts/build.sh',
      'secrets.json.md',
      'src/internals.ts',
      'src/app.ts',
      'other/docs/private/plan.md',
    ]) {
      expect(excluded(p), p).toBe(false);
    }
  });

  it('match nothing when empty or blank', () => {
    expect(excludeFilesMatcher([])('a.ts')).toBe(false);
    expect(excludeFilesMatcher(['', '  '])('a.ts')).toBe(false);
  });
});

/** VS Code's parts the Copilot check uses, with `fileIsIgnored` answering as given. */
function env(
  fileIsIgnored: ((uri: { fsPath: string }) => Promise<boolean>) | undefined,
  /** null: Copilot Chat isn't installed. */
  active: boolean | null = true,
  extra: Partial<CopilotEnv> = {},
): CopilotEnv & { asked: string[]; cancelled: number } {
  const state = { asked: [] as string[], cancelled: 0 };
  return Object.assign(state, {
    lm: fileIsIgnored
      ? {
          fileIsIgnored: (uri: { fsPath: string }) => {
            state.asked.push(uri.fsPath);
            return fileIsIgnored(uri);
          },
        }
      : {},
    copilotChat: () => (active === null ? undefined : { isActive: active }),
    uri: (file: string) => ({ fsPath: file }) as vscode.Uri,
    tokenSource: () =>
      ({
        token: {},
        cancel: () => state.cancelled++,
        dispose: () => {},
      }) as unknown as vscode.CancellationTokenSource,
    ...extra,
  });
}

describe('the Copilot content exclusion check', () => {
  it("answers with Copilot's answer while Copilot Chat is active", async () => {
    const check = copilotExclusionCheck(env(async (uri) => uri.fsPath.endsWith('plan.ts')));
    expect(await check('/repo/deals/plan.ts', signal())).toEqual({ excluded: true });
    expect(await check('/repo/src/a.ts', signal())).toEqual({ excluded: false });
  });

  it('is unavailable when the proposed API is not enabled (the call throws)', async () => {
    const check = copilotExclusionCheck(
      env(async () => {
        throw new Error(
          "Extension 'serhii.ai-code-reviewer' CANNOT use API proposal: chatParticipantAdditions.",
        );
      }),
    );
    expect(await check('/repo/a.ts', signal())).toEqual({ unavailable: 'proposal' });
  });

  it('is unavailable when Copilot Chat is not installed or not active', async () => {
    // VS Code answers "not ignored" when no extension provides the answer.
    for (const active of [false, null]) {
      const check = copilotExclusionCheck(env(async () => false, active));
      expect(await check('/repo/a.ts', signal())).toEqual({ unavailable: 'copilot' });
    }
  });

  it('is unavailable without the API, or when the call fails or hangs', async () => {
    expect(await copilotExclusionCheck(env(undefined))('/repo/a.ts', signal())).toEqual({
      unavailable: 'noApi',
    });
    const failing = copilotExclusionCheck(env(async () => Promise.reject(new Error('boom'))));
    expect(await failing('/repo/a.ts', signal())).toEqual({ unavailable: 'failed' });
    const hanging = copilotExclusionCheck(
      env(() => new Promise<boolean>(() => {}), true, { timeoutMs: 10 }),
    );
    expect(await hanging('/repo/a.ts', signal())).toEqual({ unavailable: 'failed' });
  });

  it('rejects when the review is cancelled, and cancels the question', async () => {
    const e = env(() => new Promise<boolean>(() => {}));
    const controller = new AbortController();
    const answer = copilotExclusionCheck(e)('/repo/a.ts', controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(answer).rejects.toThrow('cancelled');
    expect(e.cancelled).toBe(1);
  });
});

describe('the exclusion of one review', () => {
  const root = path.resolve('/repo');
  const fake = (answer: (file: string) => CopilotAnswer) => {
    const asked: string[] = [];
    const check: CopilotExclusionCheck = async (file) => {
      asked.push(file);
      return answer(file);
    };
    return { check, asked };
  };

  it('excludes what the setting or Copilot excludes, asking Copilot once per file', async () => {
    const copilot = fake((f) => ({ excluded: f.endsWith('plan.ts') }));
    const review = new ContentExclusion(copilot.check, 'serhii.ai-code-reviewer').forReview(root, [
      'secrets/',
    ]);
    expect(await review.match('secrets/key.txt', signal())).toBe('setting');
    expect(await review.match('deals/plan.ts', signal())).toBe('copilot');
    expect(await review.isExcluded('deals/plan.ts', signal())).toBe(true);
    expect(await review.isExcluded('src/a.ts', signal())).toBe(false);
    // Files the setting excludes aren't even asked about.
    expect(copilot.asked).toEqual([
      path.join(root, 'deals', 'plan.ts'),
      path.join(root, 'src', 'a.ts'),
    ]);
    expect(review.warning()).toBeUndefined();
  });

  it('without the Copilot check, still applies the setting and warns once with how to enable it', async () => {
    const copilot = fake(() => ({ unavailable: 'proposal' }));
    const review = new ContentExclusion(copilot.check, 'serhii.ai-code-reviewer').forReview(root, [
      '*.cfg',
    ]);
    expect(await review.isExcluded('app.cfg', signal())).toBe(true);
    expect(await review.isExcluded('src/a.ts', signal())).toBe(false);
    expect(await review.isExcluded('src/b.ts', signal())).toBe(false);
    // Not asked again once it can't answer.
    expect(copilot.asked).toHaveLength(1);
    expect(review.warning()).toBe(
      'Copilot content exclusion was not checked: VS Code only lets AI Review ask Copilot when its proposed API is enabled for AI Review. To check it, add "enable-proposed-api": ["serhii.ai-code-reviewer"] to argv.json (command "Preferences: Configure Runtime Arguments"), restart VS Code, and keep GitHub Copilot Chat installed and signed in. Files in aiReview.excludeFiles were still left out.',
    );
  });

  it('says why Copilot could not answer', async () => {
    const warning = async (answer: CopilotAnswer) => {
      const review = new ContentExclusion(async () => answer, 'x.y').forReview(root, []);
      await review.isExcluded('a.ts', signal());
      return review.warning();
    };
    expect(await warning({ unavailable: 'copilot' })).toMatch(
      /^Copilot content exclusion was not checked: GitHub Copilot Chat is not installed or not running\. To check it, add "enable-proposed-api": \["x\.y"\]/,
    );
    expect(await warning({ unavailable: 'noApi' })).toBe(
      'Copilot content exclusion was not checked: this version of VS Code cannot tell which files it excludes. Files in aiReview.excludeFiles were still left out.',
    );
    expect(await warning({ unavailable: 'failed' })).toBe(
      'Copilot content exclusion was not checked: asking Copilot failed for some files. Files in aiReview.excludeFiles were still left out.',
    );
  });

  it('keeps asking Copilot about other files after one question failed', async () => {
    const copilot = fake((f) =>
      f.endsWith('a.ts') ? { unavailable: 'failed' } : { excluded: true },
    );
    const review = new ContentExclusion(copilot.check, 'x.y').forReview(root, []);
    expect(await review.isExcluded('a.ts', signal())).toBe(false);
    expect(await review.isExcluded('plan.ts', signal())).toBe(true);
    expect(review.warning()).toMatch(/asking Copilot failed for some files/);
  });

  it('a new review asks again', async () => {
    const copilot = fake(() => ({ excluded: false }));
    const exclusion = new ContentExclusion(copilot.check, 'x.y');
    await exclusion.forReview(root, []).isExcluded('a.ts', signal());
    await exclusion.forReview(root, []).isExcluded('a.ts', signal());
    expect(copilot.asked).toHaveLength(2);
  });
});
