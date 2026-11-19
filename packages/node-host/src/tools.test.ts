import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReviewTools, type AgentTool } from '@ai-review/core';
import { FsWorkspaceTools } from './tools';

// `readFile` records what it reads (absolute paths) and calls `onRead` first, so tests can
// see which files a tool opened and cancel in the middle. Everything else is the real fs.
const fsMock = vi.hoisted(() => ({
  reads: [] as string[],
  onRead: undefined as ((file: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const readFile = async (file: unknown, ...rest: unknown[]) => {
    fsMock.reads.push(String(file));
    fsMock.onRead?.(String(file));
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  return { ...actual, readFile };
});

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

/** The host's grep over the files git shows, as core asks it (core picks the files). */
const grepListed = async (
  ws: FsWorkspaceTools,
  pattern: string,
  glob?: string,
  signal?: AbortSignal,
) => {
  const inGlob = glob ? picomatch(glob, { dot: true }) : undefined;
  const paths = (await ws.listFiles()).filter((p) => !inGlob || inGlob(p));
  return ws.grep(pattern, paths, signal);
};

/** The review tools on a host, through core's checks. */
const toolsOn = (ws: FsWorkspaceTools) => {
  const tools = new Map(createReviewTools(ws).map((t) => [t.def.name, t]));
  return (name: string, input: unknown) => {
    const tool = tools.get(name)! as unknown as AgentTool<unknown>;
    return tool.run(tool.schema.parse(input), new AbortController().signal);
  };
};

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

  it('grep searches tracked and untracked files but skips large, binary, skipped-dir and symlinked ones', async () => {
    const ws = new FsWorkspaceTools(root);
    // Raw IO: the secret file is searched too; core never asks for it (below).
    expect(hitsOf(await grepListed(ws, 'needle')).sort()).toEqual([
      '.env:1',
      'src/a.ts:2',
      'src/new.ts:2',
    ]);
    if (linked) expect(hitsOf(await grepListed(ws, 'outside'))).toEqual([]);
    expect(await toolsOn(ws)('search_code', { pattern: 'needle' })).toBe(
      'src/a.ts:2: // needle tracked\nsrc/new.ts:2: // needle untracked',
    );
  });

  it('grep stops at maxGrepResults; findReferences falls back to grep', async () => {
    const ws = new FsWorkspaceTools(root, { maxGrepResults: 1 });
    expect(await grepListed(ws, 'needle')).toHaveLength(1);
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
    // Other spellings of the same files.
    await expect(run('read_file', { path: './.aws/../.aws/credentials' })).rejects.toThrow();
    await expect(run('read_file', { path: '.aws\\credentials' })).rejects.toThrow();
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'refuses other casings of an ignored file where the file system ignores case',
    async () => {
      const run = toolsOn(new FsWorkspaceTools(root));
      await expect(run('read_file', { path: 'Secrets.YML' })).rejects.toThrow(/ignored by git/);
      await expect(run('read_file', { path: '.AWS/Credentials' })).rejects.toThrow(
        /ignored by git/,
      );
      expect(await run('read_file', { path: 'SRC/App.ts' })).toContain('loadConfig');
    },
  );

  it('read_file refuses an ignored file reached through a junction', async () => {
    if (!linked) return;
    const ws = new FsWorkspaceTools(root);
    // Git on Windows lists the file by the junction's name; core checks where it really is.
    await expect(toolsOn(ws)('read_file', { path: 'awslink/credentials' })).rejects.toThrow(
      /ignored by git/,
    );
    expect(await grepListed(ws, 'HIDDEN_VALUE', 'awslink/**')).toEqual([]);
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
    expect(await grepListed(ws, 'HIDDEN_VALUE', '.aws/**')).toEqual([]);
    expect(await grepListed(ws, 'leak')).toEqual([]);
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
      const run = toolsOn(new FsWorkspaceTools(plain));
      await expect(run('read_file', { path: 'a.ts' })).rejects.toThrow(/git/);
      await expect(run('search_code', { pattern: 'a' })).rejects.toThrow(/git/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const broken = toolsOn(new FsWorkspaceTools(root, { gitPath: path.join(root, 'no-such-git') }));
    await expect(broken('read_file', { path: 'src/app.ts' })).rejects.toThrow(/git/);
    // The model is not shown git's output (it can contain absolute paths).
    await expect(broken('read_file', { path: 'src/app.ts' })).rejects.not.toThrow(root);
  });
});

describe('tool calls can be cancelled and are bounded (F8)', () => {
  let root: string;
  const FILES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
  const isAbort = (err: unknown) => (err as Error | undefined)?.name === 'AbortError';
  const readsUnderRoot = () => fsMock.reads.filter((f) => f.startsWith(root));

  beforeAll(() => {
    const repo = makeRepo('air-cancel-');
    root = repo.root;
    for (const f of FILES) repo.write(`src/${f}`, `export const needle = '${f}';\n`);
    // Over the read limit, by one byte.
    repo.write('huge.txt', `HUGE_CONTENT\n${'x'.repeat(2 * 1024 * 1024 - 12)}`);
    // Catastrophic backtracking for /^(a+)+$/.
    repo.write('slow.txt', `${'a'.repeat(40)}!\n`);
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'init');
  });

  afterAll(() => {
    fsMock.onRead = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('grep stops walking when the signal is aborted', async () => {
    const ws = new FsWorkspaceTools(root);
    const listed = await ws.listFiles();
    const controller = new AbortController();
    fsMock.reads.length = 0;
    fsMock.onRead = () => controller.abort();
    try {
      const err = await ws.grep('needle', listed, controller.signal).catch((e: unknown) => e);
      expect(isAbort(err), String(err)).toBe(true);
    } finally {
      fsMock.onRead = undefined;
    }
    expect(readsUnderRoot()).toHaveLength(1);

    // Aborted before it starts: nothing is read.
    fsMock.reads.length = 0;
    await expect(ws.grep('needle', listed, controller.signal)).rejects.toSatisfy(isAbort);
    expect(readsUnderRoot()).toEqual([]);
  });

  it('grep stops a slow regex when the signal is aborted, before its timeout', async () => {
    const ws = new FsWorkspaceTools(root, { grepTimeoutMs: 60_000 });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    await expect(ws.grep('^(a+)+$', ['slow.txt'], controller.signal)).rejects.toSatisfy(isAbort);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('readFile refuses a file over the size limit without reading it', async () => {
    const ws = new FsWorkspaceTools(root);
    fsMock.reads.length = 0;
    await expect(ws.readFile('huge.txt')).rejects.toThrow(/too large/);
    await expect(ws.readFile('huge.txt', { start: 1, end: 1 })).rejects.toThrow(/too large/);
    expect(readsUnderRoot()).toEqual([]);
    const tools = new Map(createReviewTools(ws).map((t) => [t.def.name, t]));
    const tool = tools.get('read_file')! as unknown as AgentTool<unknown>;
    const message = await tool
      .run(tool.schema.parse({ path: 'huge.txt' }), new AbortController().signal)
      .then(
        () => 'no error',
        (e: unknown) => String((e as Error).message),
      );
    expect(message).toMatch(/huge\.txt is too large/);
    expect(message).not.toContain('HUGE_CONTENT');
    expect(message).not.toContain(root);
  });

  it('readFile does not read once the signal is aborted', async () => {
    const ws = new FsWorkspaceTools(root);
    const controller = new AbortController();
    controller.abort();
    fsMock.reads.length = 0;
    await expect(ws.readFile('src/a.ts', undefined, controller.signal)).rejects.toSatisfy(isAbort);
    expect(readsUnderRoot()).toEqual([]);
  });
});

describe('tool errors do not show where the repo is (F5)', () => {
  let root: string;

  beforeAll(() => {
    const repo = makeRepo('air-errors-');
    root = repo.root;
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'init');
  });

  afterAll(() => {
    fsMock.onRead = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /** Error messages of each tool while every file read fails with `fail(absolutePath)`. */
  const errorsWhile = async (fail: (file: string) => Error) => {
    const tools = new Map(
      createReviewTools(new FsWorkspaceTools(root)).map((t) => [t.def.name, t]),
    );
    const run = (name: string, input: unknown) => {
      const tool = tools.get(name)! as unknown as AgentTool<unknown>;
      return tool.run(tool.schema.parse(input), new AbortController().signal).then(
        () => 'no error',
        (e: unknown) => String((e as Error).message),
      );
    };
    fsMock.onRead = (file) => {
      throw fail(file);
    };
    try {
      return {
        read_file: await run('read_file', { path: 'src/a.ts' }),
        get_symbol: await run('get_symbol', { path: 'src/a.ts', line: 1 }),
        find_references: await run('find_references', { path: 'src/a.ts', line: 1, symbol: 'a' }),
        search_code: await run('search_code', { pattern: 'a' }),
      };
    } finally {
      fsMock.onRead = undefined;
    }
  };

  it('a locked file is named by its repo path and error code', async () => {
    const errors = await errorsWhile((file) =>
      Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), {
        code: 'EBUSY',
      }),
    );
    expect(errors).toEqual({
      read_file: "src/a.ts can't be read (EBUSY).",
      get_symbol: "src/a.ts can't be read (EBUSY).",
      find_references: "src/a.ts can't be read (EBUSY).",
      search_code: 'The search failed (EBUSY).',
    });
  });

  it('the repo root is cut out of errors without a code', async () => {
    const errors = await errorsWhile((file) => new Error(`could not open ${file} now`));
    for (const message of Object.values(errors)) {
      expect(message).not.toContain(root);
      expect(message).not.toContain(path.basename(root));
      expect(message).toMatch(/^could not open src[\\/]a\.ts now$/);
    }
  });
});
