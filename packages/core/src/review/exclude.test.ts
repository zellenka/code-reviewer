import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ReviewConfig } from '../config/schema';
import { addedFileDiff, parseUnifiedDiff } from '../diff/parse';
import type { FileDiff, UnifiedDiff, WorkspaceTools } from '../diff/types';
import { noopLogger } from '../logger';
import { MockProvider, mockToolCall } from '../provider/mock';
import type { ModelInfo } from '../provider/types';
import { cacheExclusion, removeExcluded, type IsExcluded } from './exclude';
import { REPORT_TOOL_NAME } from './output';
import { estimateReview, prepareDiff, runReview } from './orchestrator';
import { loadRepoRules } from './rules';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
};
const AGENTIC: ReviewConfig = {
  ...DEFAULT_CONFIG,
  review: { ...DEFAULT_CONFIG.review, mode: 'agentic' },
};

const PLAN =
  'export function acquireAcmeCorp(price: number) {\n  return price * 2; // ACME_DEAL\n}\n';

/** A normal change, a file under `deals/` (excluded) and a rename out of `deals/`. */
function diff(): UnifiedDiff {
  const renamed = parseUnifiedDiff(
    [
      'diff --git a/deals/old-terms.ts b/src/terms.ts',
      'similarity index 90%',
      'rename from deals/old-terms.ts',
      'rename to src/terms.ts',
      '--- a/deals/old-terms.ts',
      '+++ b/src/terms.ts',
      '@@ -1,1 +1,1 @@',
      '-export const terms = 1;',
      '+export const terms = "RENAMED_TERMS";',
      '',
    ].join('\n'),
  ).files;
  return {
    files: [
      addedFileDiff('src/a.ts', 'export const a = "PLAIN_CHANGE";\n'),
      addedFileDiff('deals/acme-merger.ts', PLAN),
      ...renamed,
      // A secret file that is also excluded: only counted, not named as a secret.
      addedFileDiff('deals/.env', 'TOKEN=EXCLUDED_SECRET\n'),
    ],
  };
}

/** Excludes `deals/` and records what it was asked. */
function excluder(): IsExcluded & { asked: string[] } {
  const asked: string[] = [];
  const fn = async (p: string) => {
    asked.push(p);
    return p.startsWith('deals/');
  };
  return Object.assign(fn, { asked });
}

const provider = () =>
  new MockProvider({ fallback: mockToolCall(REPORT_TOOL_NAME, { findings: [] }) });
const options = { model: MODEL, config: DEFAULT_CONFIG, summary: true };

describe('files excluded from AI review', () => {
  it('are skipped as excluded, renames by either name, and never reach the model', async () => {
    const p = provider();
    const result = await runReview(diff(), { ...options, provider: p, isExcluded: excluder() });
    expect(result.reviewedFiles).toEqual(['src/a.ts']);
    expect(result.skipped).toEqual([
      { path: 'deals/acme-merger.ts', reason: 'excluded' },
      { path: 'src/terms.ts', reason: 'excluded' },
      { path: 'deals/.env', reason: 'excluded' },
    ]);
    const sent = JSON.stringify(p.requests);
    expect(sent).toContain('PLAIN_CHANGE');
    // Not their content, context or declarations, and not their names.
    expect(sent).not.toMatch(/ACME_DEAL|acquireAcmeCorp|RENAMED_TERMS|EXCLUDED_SECRET/);
    expect(sent).not.toMatch(/acme-merger|old-terms|src\/terms\.ts|deals\//);
    // The summary only counts them.
    expect(sent).toContain('Not reviewed: 3 files excluded from AI review');
  });

  it('are taken out of a diff the host prepared without them', async () => {
    const isExcluded = excluder();
    const prepared = prepareDiff(diff(), options);
    expect(prepared.files.map((f) => f.path)).toContain('deals/acme-merger.ts');
    const p = provider();
    const result = await runReview(prepared, { ...options, provider: p, isExcluded });
    expect(result.reviewedFiles).toEqual(['src/a.ts']);
    expect(JSON.stringify(p.requests)).not.toMatch(/ACME_DEAL|acme-merger/);
  });

  it('taken out by the host first, are only counted in the estimate and asked about once', async () => {
    const inner = excluder();
    const cached = cacheExclusion(inner);
    const { diff: kept, excluded } = await removeExcluded(
      diff(),
      cached,
      new AbortController().signal,
    );
    const reviewOptions = { ...options, leftOut: excluded, isExcluded: cached };
    const prepared = prepareDiff(kept, reviewOptions);
    expect(estimateReview(prepared, reviewOptions)).toMatchObject({ files: 1, skipped: 3 });
    const before = inner.asked.length;
    const result = await runReview(prepared, { ...reviewOptions, provider: provider() });
    expect(result.skipped.filter((s) => s.reason === 'excluded')).toHaveLength(3);
    // runReview asks again only about what is still in the diff, and the host's cache answers.
    expect(inner.asked.length).toBe(before);
  });

  it('their rules files are left out', async () => {
    const rules = {
      sources: [
        { path: 'AGENTS.md', text: 'Check null handling.' },
        { path: 'deals/rules.md', text: 'ACME_RULE: never mention the merger.' },
      ],
    };
    const p = provider();
    const result = await runReview(diff(), {
      ...options,
      provider: p,
      rules,
      isExcluded: excluder(),
    });
    expect(result.rules).toEqual(['AGENTS.md']);
    const system = JSON.stringify(p.requests.map((r) => r.system));
    expect(system).toContain('Check null handling.');
    expect(system).not.toMatch(/ACME_RULE|deals\/rules\.md/);
  });

  it('the rules loader refuses them by name and by where they really are', async () => {
    const files: Record<string, string> = {
      '.codereview.md': 'ACME_RULE one',
      'AGENTS.md': 'see deals',
      '.github/copilot-instructions.md': 'PLAIN_RULE',
    };
    const warnings: string[] = [];
    const logger = { ...noopLogger, warn: (m: string) => void warnings.push(m) };
    const rules = await loadRepoRules(async (p) => files[p], DEFAULT_CONFIG, {
      logger,
      // AGENTS.md is a link into deals/.
      realPath: async (p) => (p === 'AGENTS.md' ? 'deals/agents.md' : p),
      isExcluded: async (p) => p === '.codereview.md' || p.startsWith('deals/'),
    });
    expect(rules.sources.map((s) => s.path)).toEqual(['.github/copilot-instructions.md']);
    expect(warnings).toEqual([
      'rules file .codereview.md ignored: it is excluded from AI review',
      'rules file AGENTS.md ignored: it is excluded from AI review',
    ]);
  });

  it('agentic reviews cannot read them', async () => {
    const repo: Record<string, string> = {
      'src/a.ts': 'export const a = "PLAIN_CHANGE";\n',
      'deals/acme-merger.ts': PLAN,
    };
    const ws: WorkspaceTools = {
      listFiles: async () => Object.keys(repo),
      realPath: async (p) => p,
      readFile: async (p) => repo[p] ?? '',
      grep: async (pattern, paths) =>
        paths.flatMap((path) =>
          (repo[path] ?? '')
            .split('\n')
            .flatMap((text, i) => (text.includes(pattern) ? [{ path, line: i + 1, text }] : [])),
        ),
      findReferences: async () => [],
      getSymbolAt: async () => null,
    };
    const p = new MockProvider({
      script: [
        mockToolCall('read_file', { path: 'deals/acme-merger.ts' }),
        mockToolCall('search_code', { pattern: 'return' }),
        mockToolCall(REPORT_TOOL_NAME, { findings: [] }),
      ],
      fallback: mockToolCall(REPORT_TOOL_NAME, { findings: [] }),
    });
    const result = await runReview(
      { files: [addedFileDiff('src/a.ts', repo['src/a.ts']!)] },
      { provider: p, model: MODEL, config: AGENTIC, workspace: ws, isExcluded: excluder() },
    );
    expect(result.mode).toBe('agentic');
    const sent = JSON.stringify(p.requests);
    expect(sent).toContain("deals/acme-merger.ts can't be read: it is excluded from AI review.");
    expect(sent).toContain('No matches.');
    expect(sent).not.toMatch(/ACME_DEAL|acquireAcmeCorp/);
  });
});

describe('removeExcluded', () => {
  const signal = () => new AbortController().signal;
  const files = (...paths: string[]): FileDiff[] => paths.map((p) => addedFileDiff(p, 'x\n'));

  it('asks about the old name of a rename too', async () => {
    const asked: string[] = [];
    const renamed = { ...addedFileDiff('src/new.ts', 'x\n'), oldPath: 'deals/old.ts' };
    const { diff: kept, excluded } = await removeExcluded(
      { files: [...files('src/a.ts'), renamed] },
      async (p) => {
        asked.push(p);
        return p.startsWith('deals/');
      },
      signal(),
    );
    expect(kept.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(excluded).toEqual([{ path: 'src/new.ts', reason: 'excluded' }]);
    expect(asked.sort()).toEqual(['deals/old.ts', 'src/a.ts', 'src/new.ts']);
  });

  it('counts a file as excluded when the review is cancelled while it is asked about', async () => {
    const controller = new AbortController();
    const result = removeExcluded(
      { files: files('src/a.ts') },
      (_p, s) =>
        new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('stop')))),
      controller.signal,
    );
    controller.abort();
    expect((await result).excluded).toEqual([{ path: 'src/a.ts', reason: 'excluded' }]);
  });

  it('fails when the check fails otherwise', async () => {
    await expect(
      removeExcluded(
        { files: files('src/a.ts') },
        async () => Promise.reject(new Error('down')),
        signal(),
      ),
    ).rejects.toThrow('down');
  });
});

describe('cacheExclusion', () => {
  it('asks once per path, and again after a failed question', async () => {
    let calls = 0;
    let fail = true;
    const cached = cacheExclusion(async () => {
      calls++;
      if (fail) throw new Error('cancelled');
      return true;
    });
    const signal = new AbortController().signal;
    await expect(cached('a', signal)).rejects.toThrow('cancelled');
    fail = false;
    expect(await cached('a', signal)).toBe(true);
    expect(await cached('a', signal)).toBe(true);
    expect(calls).toBe(2);
  });
});
