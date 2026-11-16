import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReviewTools, type AgentTool } from '@ai-review/core';
import { FsWorkspaceTools } from './tools';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function makeRepo(prefix: string) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: ENV, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  return { root, git, write };
}

/** A directory junction needs no privileges on Windows (file symlinks may). */
function tryLink(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, 'junction');
    return true;
  } catch {
    return false;
  }
}

const hitsOf = (hits: { path: string; line: number }[]) => hits.map((h) => `${h.path}:${h.line}`);

describe('FsWorkspaceTools in a git repo', () => {
  let root: string;
  let outside: string;
  let linked: boolean;

  beforeAll(() => {
    const repo = makeRepo('air-tools-');
    root = repo.root;
    outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-tools-out-')));
    writeFileSync(path.join(outside, 'far.ts'), 'needle outside\n');
    repo.write('src/a.ts', 'export const answer = 42;\n// needle tracked\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'init');
    repo.write('src/new.ts', 'import { answer } from "./a";\n// needle untracked\n');
    repo.write('big.txt', `needle big\n${'x'.repeat(1024 * 1024)}\n`);
    repo.write('bin.dat', Buffer.from('needle binary\n\0\0\0', 'utf8'));
    repo.write('.env', 'needle=secret\n');
    repo.write('node_modules/dep/index.js', '// needle dependency\n');
    linked = tryLink(outside, path.join(root, 'link'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads tracked and untracked files', async () => {
    const ws = new FsWorkspaceTools(root);
    expect(await ws.readFile('src/a.ts')).toBe('export const answer = 42;\n// needle tracked\n');
    expect(await ws.readFile('src/new.ts', { start: 2, end: 2 })).toBe('// needle untracked');
  });

  it('grep searches tracked and untracked files but skips large, binary, secret, skipped-dir and symlinked ones', async () => {
    const ws = new FsWorkspaceTools(root);
    expect(hitsOf(await ws.grep('needle'))).toEqual(['src/a.ts:2', 'src/new.ts:2']);
    if (linked) expect(hitsOf(await ws.grep('outside'))).toEqual([]);
  });

  it('grep stops at maxGrepResults; findReferences falls back to grep', async () => {
    const ws = new FsWorkspaceTools(root, { maxGrepResults: 1 });
    expect(hitsOf(await ws.grep('needle'))).toEqual(['src/a.ts:2']);
    const refs = await new FsWorkspaceTools(root).findReferences('src/a.ts', 1, 15);
    expect(hitsOf(refs)).toEqual(['src/a.ts:1', 'src/new.ts:1']);
  });
});

describe('files ignored by git are not shown (F4)', () => {
  let root: string;
  let linked: boolean;
  const IGNORED = [
    'secrets.yml',
    'terraform.tfvars',
    'local.settings.json',
    '.aws/credentials',
    'deps/lib/vendored.js',
    'config/appsettings.Development.json',
  ];

  beforeAll(() => {
    const repo = makeRepo('air-ignored-');
    root = repo.root;
    repo.write('.gitignore', 'secrets.yml\n*.tfvars\nlocal.settings.json\n.aws/\ndeps/\n');
    // A nested .gitignore.
    repo.write('config/.gitignore', 'appsettings.Development.json\n');
    repo.write('src/app.ts', 'export function loadConfig() {\n  return HIDDEN_VALUE;\n}\n');
    // Tracked although it matches an ignore pattern.
    repo.write('forced.tfvars', 'region = "HIDDEN_VALUE forced"\n');
    repo.git('add', '.');
    repo.git('add', '-f', 'forced.tfvars');
    repo.git('commit', '-q', '-m', 'init');
    for (const rel of IGNORED) {
      repo.write(rel, `export function leak() {\n  return 'HIDDEN_VALUE in ${rel}';\n}\n`);
    }
    // Untracked and not ignored: an unstaged review sends it, so the tools show it.
    repo.write('src/fresh.ts', 'export const fresh = HIDDEN_VALUE;\n');
    // Git lists files under a junction by the junction's name; the target is ignored.
    linked = tryLink(path.join(root, '.aws'), path.join(root, 'awslink'));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const toolsOn = (ws: FsWorkspaceTools) => {
    const tools = new Map(createReviewTools(ws).map((t) => [t.def.name, t]));
    return (name: string, input: unknown) => {
      const tool = tools.get(name)! as unknown as AgentTool<unknown>;
      return tool.run(tool.schema.parse(input), new AbortController().signal);
    };
  };
  const errorOf = async (p: Promise<unknown>) =>
    p.then(
      () => 'no error',
      (e: unknown) => String((e as Error).message),
    );

  it('read_file refuses ignored files without saying whether they exist', async () => {
    const run = toolsOn(new FsWorkspaceTools(root));
    for (const rel of IGNORED) {
      const message = await errorOf(run('read_file', { path: rel }));
      expect(message, rel).not.toBe('no error');
      expect(message).not.toContain('HIDDEN_VALUE');
      // Same answer as for a file that isn't there.
      const missing = `${rel}.missing`;
      expect(message.replaceAll(rel, '<p>')).toBe(
        (await errorOf(run('read_file', { path: missing }))).replaceAll(missing, '<p>'),
      );
    }
    // Other spellings of the same files, and the host interface directly.
    await expect(run('read_file', { path: './.aws/../.aws/credentials' })).rejects.toThrow();
    const ws = new FsWorkspaceTools(root);
    await expect(ws.readFile('secrets.yml')).rejects.toThrow();
    await expect(ws.readFile('.aws\\credentials')).rejects.toThrow();
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'refuses other casings of an ignored file where the file system ignores case',
    async () => {
      const ws = new FsWorkspaceTools(root);
      await expect(ws.readFile('Secrets.YML')).rejects.toThrow();
      await expect(ws.readFile('.AWS/Credentials')).rejects.toThrow();
      expect(await ws.readFile('SRC/App.ts')).toContain('loadConfig');
    },
  );

  it('read_file refuses an ignored file reached through a junction', async () => {
    if (!linked) return;
    const ws = new FsWorkspaceTools(root);
    await expect(ws.readFile('awslink/credentials')).rejects.toThrow();
    expect(await ws.grep('HIDDEN_VALUE', 'awslink/**')).toEqual([]);
  });

  it('search_code shows no hits from ignored files, also under ignored directories', async () => {
    const run = toolsOn(new FsWorkspaceTools(root));
    const out = await run('search_code', { pattern: 'HIDDEN_VALUE' });
    expect(out.split('\n').map((l) => l.split(':')[0])).toEqual([
      'forced.tfvars',
      'src/app.ts',
      'src/fresh.ts',
    ]);
    const ws = new FsWorkspaceTools(root);
    expect(await ws.grep('HIDDEN_VALUE', '.aws/**')).toEqual([]);
    expect(await ws.grep('leak')).toEqual([]);
  });

  it('untracked files that are not ignored, and force-added files, stay readable', async () => {
    const run = toolsOn(new FsWorkspaceTools(root));
    expect(await run('read_file', { path: 'src/fresh.ts' })).toContain('fresh = HIDDEN_VALUE');
    expect(await run('read_file', { path: 'forced.tfvars' })).toContain('HIDDEN_VALUE forced');
    expect(await run('search_code', { pattern: 'fresh =' })).toBe(
      'src/fresh.ts:1: export const fresh = HIDDEN_VALUE;',
    );
  });

  it('find_references and get_symbol show nothing from ignored files', async () => {
    const run = toolsOn(new FsWorkspaceTools(root));
    const refs = await run('find_references', {
      path: 'src/app.ts',
      line: 2,
      symbol: 'HIDDEN_VALUE',
    });
    expect(refs.split('\n').map((l) => l.split(':')[0])).toEqual([
      'forced.tfvars',
      'src/app.ts',
      'src/fresh.ts',
    ]);
    await expect(run('get_symbol', { path: 'secrets.yml', line: 2 })).rejects.toThrow();
    await expect(
      run('find_references', { path: '.aws/credentials', line: 1, symbol: 'leak' }),
    ).rejects.toThrow();
  });

  it('fails closed outside a git repository and when git fails', async () => {
    const plain = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-nogit-')));
    try {
      writeFileSync(path.join(plain, 'a.ts'), 'const a = 1;\n');
      const ws = new FsWorkspaceTools(plain);
      await expect(ws.readFile('a.ts')).rejects.toThrow(/git/);
      await expect(ws.grep('a')).rejects.toThrow(/git/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const broken = new FsWorkspaceTools(root, { gitPath: path.join(root, 'no-such-git') });
    await expect(broken.readFile('src/app.ts')).rejects.toThrow(/git/);
    // The model is not shown git's output (it can contain absolute paths).
    await expect(broken.readFile('src/app.ts')).rejects.not.toThrow(root);
  });
});
