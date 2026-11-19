import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createReviewTools, isProtectedPath, type AgentTool } from '@ai-review/core';
import { loadRepoRulesFromDisk, readRepoText } from './rules';
import { FsWorkspaceTools } from './tools';

/** The tools show only the files git lists (untracked ones too), so they need a repo. */
const gitInit = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
};

const base = mkdtempSync(path.join(tmpdir(), 'air-rules-'));
const root = path.join(base, 'repo');
gitInit(root);
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
  // A new instance per call: the tests add files, and an instance lists the files once.
  const run = (name: string, input: unknown) => {
    const tools = new Map(
      createReviewTools(new FsWorkspaceTools(root)).map((t) => [t.def.name, t]),
    );
    const tool = tools.get(name)! as unknown as AgentTool<unknown>;
    return tool.run(tool.schema.parse(input), new AbortController().signal);
  };

  it('refuses paths outside the repo and secret files', async () => {
    await expect(run('read_file', { path: '../outside.md' })).rejects.toThrow(/outside/);
    await expect(run('read_file', { path: '.env' })).rejects.toThrow(/secrets/);
    expect(await run('search_code', { pattern: 'TOKEN' })).toBe('No matches.');
    expect(await run('read_file', { path: 'AGENTS.md' })).toContain('Never use `any`');
  });

  it('search_code cuts long lines and redacts secrets', async () => {
    const wide = `const wide = '${'x'.repeat(600)}';`;
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    writeFileSync(
      path.join(root, 'sub', 'wide.ts'),
      `${wide}\n  const id = 'AKIAIOSFODNN7EXAMPLE';\n`,
    );
    expect(await run('search_code', { pattern: 'const wide' })).toBe(
      `sub/wide.ts:1: ${wide.slice(0, 500)}`,
    );
    expect(await run('search_code', { pattern: 'AKIA', glob: 'sub/**' })).toBe(
      "sub/wide.ts:2: const id = '[REDACTED:aws-access-key]';",
    );
  });

  it('redacts private key lines when a read or a search starts inside the block', async () => {
    const body = Array.from({ length: 8 }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC000${i}`);
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    writeFileSync(
      path.join(root, 'sub', 'fixture.ts'),
      [
        'export const pem = `',
        '-----BEGIN PRIVATE KEY-----',
        ...body,
        '-----END PRIVATE KEY-----',
        '`;',
        'export const after = pem.length;',
        '',
      ].join('\r\n'),
    );
    expect(await run('read_file', { path: 'sub/fixture.ts', startLine: 4, endLine: 6 })).toBe(
      'sub/fixture.ts lines 4-6:\n     4  [REDACTED:private-key]\n     5  [REDACTED:private-key]\n     6  [REDACTED:private-key]\n… (13 lines in total; ask for startLine 7+)',
    );
    const hits = await run('search_code', { pattern: 'MIIEvQ|pem\\.length' });
    expect(hits).toBe(
      [
        ...body.map((_, i) => `sub/fixture.ts:${i + 3}: [REDACTED:private-key]`),
        'sub/fixture.ts:13: export const after = pem.length;',
      ].join('\n'),
    );
  });

  it('search_code hides hits past the point where a large file is cut', async () => {
    const dir = path.join(base, 'repo4');
    gitInit(dir);
    writeFileSync(
      path.join(dir, 'large.ts'),
      [
        'const first = 1; // marker',
        '-----BEGIN PRIVATE KEY-----',
        ...Array.from({ length: 10 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'),
        '-----END PRIVATE KEY-----',
        'const last = 2; // marker',
        '',
      ].join('\n'),
    );
    const small = new Map(
      createReviewTools(new FsWorkspaceTools(dir, { maxReadChars: 120 })).map((t) => [
        t.def.name,
        t,
      ]),
    );
    const search = small.get('search_code')! as unknown as AgentTool<unknown>;
    const out = await search.run({ pattern: 'marker|MIIEvQ' }, new AbortController().signal);
    expect(out).not.toContain('MIIEvQ');
    expect(out.split('\n')[0]).toBe('large.ts:1: const first = 1; // marker');
    expect(out.split('\n').at(-1)).toBe(
      'large.ts:14: [line not shown: it could not be checked for secrets]',
    );
  });
});

describe('secret files behind other names', () => {
  // A directory junction needs no privileges on Windows (file symlinks may).
  appendFileSync(
    path.join(root, '.git', 'config'),
    '[remote "origin"]\n\turl = https://user:pw@example.invalid\n',
  );
  let linked = true;
  try {
    symlinkSync(path.join(root, '.git'), path.join(root, 'linked'), 'junction');
  } catch {
    linked = false;
  }

  it.skipIf(!linked)('refuses a symlink that points at .git/', async () => {
    const readFile = createReviewTools(new FsWorkspaceTools(root)).find(
      (t) => t.def.name === 'read_file',
    )! as unknown as AgentTool<unknown>;
    // Git on Windows lists the file by the junction's name; core checks where it really is.
    await expect(
      readFile.run({ path: 'linked/config' }, new AbortController().signal),
    ).rejects.toThrow(/secrets|ignored by git/);
    const rules = await loadRepoRulesFromDisk(root, { rules: 'linked/config' });
    expect(JSON.stringify(rules)).not.toContain('user:pw');
    expect(rules.sources.map((s) => s.path)).not.toContain('linked/config');
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

describe('one blocked-path check for the tools and the rules (A1)', () => {
  it('the tools, the rules loader and the predicate refuse the same names', async () => {
    const dir = path.join(base, 'repo5');
    gitInit(dir);
    writeFileSync(path.join(dir, '.env'), 'TOKEN=LEAKED_ENV_VALUE\n');
    writeFileSync(path.join(dir, 'server.key'), 'LEAKED_KEY_VALUE\n');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    // Names Windows opens the same files by; elsewhere they are other (missing) files.
    const names = ['src/../.env', '.env.', '.env::$DATA', 'server.key.', 'server.key::$DATA'];
    const tools = new Map(createReviewTools(new FsWorkspaceTools(dir)).map((t) => [t.def.name, t]));
    const readFile = tools.get('read_file')! as unknown as AgentTool<unknown>;
    for (const name of names) {
      expect(isProtectedPath(name), name).toBe(true);
      const message = await readFile.run({ path: name }, new AbortController().signal).then(
        (ok) => `resolved: ${ok}`,
        (e: unknown) => String((e as Error).message),
      );
      expect(message, name).toMatch(/may contain secrets/);
      const rules = await loadRepoRulesFromDisk(dir, { rules: name });
      expect(JSON.stringify(rules), name).not.toContain('LEAKED');
    }
  });
});

describe('grep with a model-written pattern', () => {
  it('fails fast on a catastrophic regex instead of blocking the host', async () => {
    const dir = path.join(base, 'repo3');
    gitInit(dir);
    writeFileSync(path.join(dir, 'a.txt'), `${'a'.repeat(40)}!\n`);
    const ws = new FsWorkspaceTools(dir, { grepTimeoutMs: 300 });
    const started = Date.now();
    await expect(ws.grep('^(a+)+$', ['a.txt'])).rejects.toThrow(/too slow/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A normal search still works.
    expect(await ws.grep('a{40}', ['a.txt'])).toEqual([
      { path: 'a.txt', line: 1, text: `${'a'.repeat(40)}!` },
    ]);
  });
});
