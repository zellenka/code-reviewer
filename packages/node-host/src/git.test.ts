import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDiffSourceError } from '@ai-review/core';
import {
  FsWorkspaceTools,
  GitCliDiffSource,
  findRepoRoot,
  isSafeRef,
  resolveInRepo,
} from './index';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function makeRepo(): { root: string; git: (...args: string[]) => string } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-git-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: ENV, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  return { root, git };
}

describe('GitCliDiffSource', () => {
  let root: string;
  let git: (...args: string[]) => string;
  let source: GitCliDiffSource;
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };

  beforeAll(() => {
    ({ root, git } = makeRepo());
    write('keep.txt', 'one\ntwo\nthree\n');
    write('gone.txt', 'bye\n');
    write('old-name.txt', 'a\nb\nc\nd\ne\nf\n');
    write('crlf.txt', 'x\r\ny\r\n');
    write('noeol.txt', 'last');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'feature');

    // Committed on the branch.
    write('feature.ts', 'export const f = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feature');

    // Staged.
    git('rm', '-q', 'gone.txt');
    git('mv', 'old-name.txt', 'new-name.txt');
    write('staged.ts', 'export const s = 2;\n');
    write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    git('add', '.');

    // Unstaged + untracked (added after staging so they stay unstaged).
    write('keep.txt', 'one\nTWO\nthree\n');
    write('crlf.txt', 'x\r\nY\r\n');
    write('noeol.txt', 'last changed');
    write('untracked/u.ts', 'const u = 3;\r\n');
    source = new GitCliDiffSource({ root });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds the repo root, and reports a missing repo clearly', async () => {
    expect(await findRepoRoot(path.join(root, 'untracked'))).toBe(path.resolve(root));
    const outside = mkdtempSync(path.join(tmpdir(), 'air-norepo-'));
    await expect(findRepoRoot(outside)).rejects.toSatisfy(
      (e) => isDiffSourceError(e) && e.kind === 'noRepo',
    );
    rmSync(outside, { recursive: true, force: true });
  });

  it('unstaged: modified files (CRLF, no EOL) plus untracked files', async () => {
    const { files } = await source.getDiff({ kind: 'unstaged' });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      'crlf.txt',
      'keep.txt',
      'noeol.txt',
      'untracked/u.ts',
    ]);
    expect(byPath['keep.txt']!.hunks[0]!.lines.find((l) => l.kind === 'add')).toEqual({
      kind: 'add',
      text: 'TWO',
      newLine: 2,
    });
    expect(byPath['keep.txt']!.newContent).toBe('one\nTWO\nthree\n');
    expect(byPath['crlf.txt']!.hunks[0]!.lines.find((l) => l.kind === 'add')?.text).toBe('Y');
    expect(byPath['crlf.txt']!.newContent).toBe('x\nY\n');
    expect(byPath['noeol.txt']!.hunks[0]!.lines.filter((l) => l.kind !== 'ctx')).toEqual([
      { kind: 'del', text: 'last', oldLine: 1 },
      { kind: 'add', text: 'last changed', newLine: 1 },
    ]);
    expect(byPath['untracked/u.ts']).toMatchObject({
      status: 'added',
      newContent: 'const u = 3;\n',
    });
  });

  it('staged: delete, rename, add and binary, with content from the index', async () => {
    const { files } = await source.getDiff({ kind: 'staged' });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted' });
    expect(byPath['new-name.txt']).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt' });
    expect(byPath['staged.ts']).toMatchObject({
      status: 'added',
      newContent: 'export const s = 2;\n',
    });
    expect(byPath['img.png']).toMatchObject({ status: 'added', binary: true });
    expect(byPath['keep.txt']).toBeUndefined();
  });

  it('branch: everything since the merge-base with main, plus the working tree', async () => {
    const { files } = await source.getDiff({ kind: 'branch' });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['feature.ts', 'staged.ts', 'keep.txt', 'untracked/u.ts']),
    );
    expect(await source.detectBase()).toBe('main');
    await expect(source.getDiff({ kind: 'branch', base: 'nope' })).rejects.toSatisfy(
      (e) => isDiffSourceError(e) && e.kind === 'noBase',
    );
  });

  it('branch on a detached HEAD gives a clear error', async () => {
    const { root: r2, git: g2 } = makeRepo();
    writeFileSync(path.join(r2, 'a'), 'a\n');
    g2('add', '.');
    g2('commit', '-q', '-m', 'a');
    g2('checkout', '-q', '--detach');
    await expect(new GitCliDiffSource({ root: r2 }).getDiff({ kind: 'branch' })).rejects.toSatisfy(
      (e) => isDiffSourceError(e) && e.kind === 'detachedHead',
    );
    rmSync(r2, { recursive: true, force: true });
  });

  it('a symlink pointing outside the repo does not break the review', async () => {
    const { root: r4, git: g4 } = makeRepo();
    const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-outside-')));
    writeFileSync(path.join(outside, 'secret.txt'), 'outside secret\n');
    writeFileSync(path.join(r4, 'a.txt'), 'a\n');
    g4('add', '.');
    g4('commit', '-q', '-m', 'a');
    writeFileSync(path.join(r4, 'a.txt'), 'b\n');
    writeFileSync(path.join(r4, 'new.txt'), 'new\n');
    let linked = true;
    try {
      symlinkSync(outside, path.join(r4, 'shared'), 'junction');
    } catch {
      linked = false;
    }
    const { files } = await new GitCliDiffSource({ root: r4 }).getDiff({ kind: 'unstaged' });
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['a.txt', 'new.txt']));
    if (linked) expect(JSON.stringify(files)).not.toContain('outside secret');
    rmSync(r4, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects option-like or range base refs', async () => {
    for (const base of ['--output=x', 'main..HEAD', 'a b']) {
      await expect(source.getDiff({ kind: 'branch', base })).rejects.toSatisfy(
        (e) => isDiffSourceError(e) && e.kind === 'noBase' && /not a valid/.test(e.message),
      );
    }
    expect(isSafeRef('origin/main')).toBe(true);
    expect(isSafeRef('release/1.2')).toBe(true);
  });

  it('staged works before the first commit', async () => {
    const { root: r3, git: g3 } = makeRepo();
    writeFileSync(path.join(r3, 'first.txt'), 'hi\n');
    g3('add', '.');
    const { files } = await new GitCliDiffSource({ root: r3 }).getDiff({ kind: 'staged' });
    expect(files).toMatchObject([{ path: 'first.txt', status: 'added' }]);
    rmSync(r3, { recursive: true, force: true });
  });

  it('file and selection modes review working-tree content', async () => {
    const file = await source.getDiff({ kind: 'file', path: 'keep.txt' });
    expect(file.files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['one', 'TWO', 'three']);
    const sel = await source.getDiff({
      kind: 'selection',
      path: 'keep.txt',
      startLine: 2,
      endLine: 2,
    });
    expect(sel.files[0]!.hunks[0]!.lines).toEqual([{ kind: 'add', text: 'TWO', newLine: 2 }]);
    expect(sel.files[0]!.newContent).toBe('one\nTWO\nthree\n');
    await expect(source.getDiff({ kind: 'file', path: '../etc/passwd' })).rejects.toSatisfy(
      (e) => isDiffSourceError(e) && e.kind === 'outsideRepo',
    );
  });
});

describe('sandbox + FsWorkspaceTools', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-fs-')));
    outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-out-')));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export function foo() {}\r\nfoo();\r\n');
    writeFileSync(path.join(root, 'src', 'b.ts'), 'import { foo } from "./a";\nfoo();\n');
    writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'foo();\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    try {
      symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      // Symlinks may need privileges; the symlink test checks for the link first.
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects absolute paths, .. escapes and symlink escapes', async () => {
    const isOutside = (e: unknown) => isDiffSourceError(e) && e.kind === 'outsideRepo';
    await expect(resolveInRepo(root, '../x')).rejects.toSatisfy(isOutside);
    await expect(resolveInRepo(root, 'src/../../x')).rejects.toSatisfy(isOutside);
    await expect(resolveInRepo(root, path.join(outside, 'secret.txt'))).rejects.toSatisfy(
      isOutside,
    );
    await expect(resolveInRepo(root, '/etc/passwd')).rejects.toSatisfy(isOutside);
    await expect(resolveInRepo(root, 'C:/Windows/win.ini')).rejects.toSatisfy(isOutside);
    await expect(resolveInRepo(root, '')).rejects.toSatisfy(isOutside);
    expect(await resolveInRepo(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(await resolveInRepo(root, 'src/new/not-yet.ts')).toBe(
      path.join(root, 'src', 'new', 'not-yet.ts'),
    );
    let hasLink = true;
    try {
      realpathSync(path.join(root, 'link'));
    } catch {
      hasLink = false;
    }
    if (hasLink) {
      await expect(resolveInRepo(root, 'link/secret.txt')).rejects.toSatisfy(isOutside);
      await expect(resolveInRepo(root, 'link/new.txt')).rejects.toSatisfy(isOutside);
    }
  });

  it('readFile normalizes EOL, supports ranges and stays in the sandbox', async () => {
    const tools = new FsWorkspaceTools(root, { maxReadChars: 30 });
    expect(await tools.readFile('src/a.ts', { start: 2, end: 2 })).toBe('foo();');
    expect(await tools.readFile('src/a.ts')).toMatch(/truncated/);
    await expect(tools.readFile('../' + path.basename(outside) + '/secret.txt')).rejects.toThrow(
      /outside/,
    );
  });

  it('grep skips node_modules and honours globs; findReferences uses grep', async () => {
    const tools = new FsWorkspaceTools(root);
    const hits = await tools.grep('foo\\(\\)');
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      'src/a.ts:1',
      'src/a.ts:2',
      'src/b.ts:2',
    ]);
    expect((await tools.grep('foo', 'src/b.ts')).every((h) => h.path === 'src/b.ts')).toBe(true);
    expect(await tools.grep('(unclosed')).toEqual([]);
    const refs = await tools.findReferences('src/a.ts', 1, 18);
    expect(refs).toHaveLength(4);
    expect(await tools.getSymbolAt()).toBeNull();
  });
});
