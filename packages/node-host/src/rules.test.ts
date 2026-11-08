import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createReviewTools, type AgentTool } from '@ai-review/core';
import { loadRepoRulesFromDisk, readRepoText } from './rules';
import { FsWorkspaceTools } from './tools';

const base = mkdtempSync(path.join(tmpdir(), 'air-rules-'));
const root = path.join(base, 'repo');
mkdirSync(path.join(root, '.github'), { recursive: true });
writeFileSync(path.join(root, 'AGENTS.md'), '- Never use `any`.\n');
writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'Prefer early returns.\n');
writeFileSync(path.join(base, 'outside.md'), 'secret rules');
writeFileSync(path.join(root, '.env'), 'TOKEN=1');

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('repo rules on disk', () => {
  it('loads the auto-read files when there is no rules file', async () => {
    const rules = await loadRepoRulesFromDisk(root, {});
    expect(rules.sources.map((s) => s.path)).toEqual([
      'AGENTS.md',
      '.github/copilot-instructions.md',
    ]);
  });

  it('ignores a rules path outside the repo', async () => {
    const warnings: string[] = [];
    const logger = {
      error: () => {},
      warn: (m: string) => warnings.push(m),
      info: () => {},
      debug: () => {},
      trace: () => {},
    };
    const rules = await loadRepoRulesFromDisk(root, { rules: '../outside.md' }, { logger });
    expect(rules.sources.map((s) => s.path)).not.toContain('../outside.md');
    expect(warnings.join()).toMatch(/outside the repository/);
    await expect(readRepoText(root, '../outside.md')).rejects.toThrow(/outside/);
    expect(await readRepoText(root, 'missing.md')).toBeUndefined();
  });
});

describe('review tools on FsWorkspaceTools', () => {
  const tools = new Map(createReviewTools(new FsWorkspaceTools(root)).map((t) => [t.def.name, t]));
  const run = (name: string, input: unknown) => {
    const tool = tools.get(name)! as unknown as AgentTool<unknown>;
    return tool.run(tool.schema.parse(input), new AbortController().signal);
  };

  it('refuses paths outside the repo and secret files', async () => {
    await expect(run('read_file', { path: '../outside.md' })).rejects.toThrow(/outside/);
    await expect(run('read_file', { path: '.env' })).rejects.toThrow(/secrets/);
    expect(await run('search_code', { pattern: 'TOKEN' })).toBe('No matches.');
    expect(await run('read_file', { path: 'AGENTS.md' })).toContain('Never use `any`');
  });
});

describe('secret files behind other names', () => {
  // A directory junction needs no privileges on Windows (file symlinks may).
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(
    path.join(root, '.git', 'config'),
    '[remote] url = https://user:pw@example.invalid',
  );
  let linked = true;
  try {
    symlinkSync(path.join(root, '.git'), path.join(root, 'linked'), 'junction');
  } catch {
    linked = false;
  }

  it.skipIf(!linked)('refuses a symlink that points at .git/', async () => {
    const ws = new FsWorkspaceTools(root);
    await expect(ws.readFile('linked/config')).rejects.toThrow(/secrets/);
    await expect(readRepoText(root, 'linked/config')).rejects.toThrow(/secrets/);
  });

  it('refuses a rules path that names a secret file and redacts rules text', async () => {
    const dir = path.join(base, 'repo2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.env'), 'TOKEN=1');
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      'Use the key ghp_abcdefghijklmnopqrstuvwxyz0123456789AB for tests.\n',
    );
    const rules = await loadRepoRulesFromDisk(dir, { rules: '.env' });
    expect(rules.sources.map((s) => s.path)).toEqual(['AGENTS.md']);
    expect(rules.sources[0]!.text).not.toContain('ghp_abcdef');
    expect(rules.sources[0]!.text).toContain('[REDACTED');
  });
});

describe('grep with a model-written pattern', () => {
  it('fails fast on a catastrophic regex instead of blocking the host', async () => {
    const dir = path.join(base, 'repo3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.txt'), `${'a'.repeat(40)}!\n`);
    const ws = new FsWorkspaceTools(dir, { grepTimeoutMs: 300 });
    const started = Date.now();
    await expect(ws.grep('^(a+)+$')).rejects.toThrow(/too slow/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A normal search still works.
    expect(await ws.grep('a{40}')).toEqual([
      { path: 'a.txt', line: 1, text: `${'a'.repeat(40)}!` },
    ]);
  });
});
