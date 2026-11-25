import type * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDiffSourceError, noopLogger } from '@ai-review/core';
import {
  FsWorkspaceTools,
  GitCliDiffSource,
  findRepoRoot,
  isInside,
  isSafeRef,
  resolveInRepo,
} from './index';

// `readFile` records what it reads and fails with the error code set for a path (absolute),
// so tests can lock or deny a file portably. Everything else is the real file system.
const fsMock = vi.hoisted(() => ({ reads: [] as string[], fail: new Map<string, string>() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const readFile = async (file: unknown, ...rest: unknown[]) => {
    fsMock.reads.push(String(file));
    const code = fsMock.fail.get(String(file));
    if (code) throw Object.assign(new Error(`${code}: mocked read failure`), { code });
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  return { ...actual, readFile };
});

// `execFile` counts the `git show` calls in flight while `track` is on, so tests can see how
// many git processes run at once. Everything else is the real `node:child_process`.
const execMock = vi.hoisted(() => ({ track: false, inFlight: 0, peak: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  const execFile = (file: string, args: string[], options: object, cb: ExecCallback) => {
    if (!execMock.track || !args.includes('show')) return actual.execFile(file, args, options, cb);
    execMock.peak = Math.max(execMock.peak, ++execMock.inFlight);
    return actual.execFile(file, args, options, (...result: Parameters<ExecCallback>) => {
      execMock.inFlight--;
      cb(...result);
    });
  };
  return { ...actual, execFile };
});
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

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
      untracked: true,
    });
    // The host decides whether to send untracked files, so they are marked; tracked ones aren't.
    expect(files.filter((f) => f.untracked).map((f) => f.path)).toEqual(['untracked/u.ts']);
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

  it('branch: everything since the merge-base with main, plus tracked working-tree changes', async () => {
    const { files } = await source.getDiff({ kind: 'branch' });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['feature.ts', 'staged.ts', 'keep.txt']));
    // Untracked files aren't part of the branch, so they are never sent.
    expect(paths).not.toContain('untracked/u.ts');
    expect(files.some((f) => f.untracked)).toBe(false);
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

  it('diff modes skip files that cannot be read, with a warning (F6)', async () => {
    const { root: r5, git: g5 } = makeRepo();
    writeFileSync(path.join(r5, 'a.txt'), 'a\n');
    g5('add', '.');
    g5('commit', '-q', '-m', 'a');
    writeFileSync(path.join(r5, 'a.txt'), 'b\n');
    for (const name of ['locked.txt', 'denied.txt', 'perm.txt', 'ok.txt']) {
      writeFileSync(path.join(r5, name), `${name}\n`);
    }
    const warnings: string[] = [];
    const logger = { ...noopLogger, warn: (m: string) => void warnings.push(m) };
    const r5Source = new GitCliDiffSource({ root: r5, logger });
    fsMock.fail.set(path.join(r5, 'locked.txt'), 'EBUSY');
    fsMock.fail.set(path.join(r5, 'denied.txt'), 'EACCES');
    fsMock.fail.set(path.join(r5, 'perm.txt'), 'EPERM');
    fsMock.fail.set(path.join(r5, 'a.txt'), 'EBUSY');
    try {
      const { files } = await r5Source.getDiff({ kind: 'unstaged' });
      // Unreadable untracked files are left out; a tracked one keeps git's hunks, no content.
      expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'ok.txt']);
      const a = files.find((f) => f.path === 'a.txt')!;
      expect(a.hunks[0]!.lines.find((l) => l.kind === 'add')?.text).toBe('b');
      expect(a.newContent).toBeUndefined();
      for (const name of ['locked.txt', 'denied.txt', 'perm.txt', 'a.txt']) {
        expect(warnings.some((w) => w.includes(name))).toBe(true);
      }

      // A file the user asked for still fails clearly; so does a non-file error in a diff.
      await expect(r5Source.getDiff({ kind: 'file', path: 'denied.txt' })).rejects.toMatchObject({
        code: 'EACCES',
      });
      fsMock.fail.set(path.join(r5, 'ok.txt'), 'EMFILE');
      await expect(r5Source.getDiff({ kind: 'unstaged' })).rejects.toMatchObject({
        code: 'EMFILE',
      });
    } finally {
      fsMock.fail.clear();
      rmSync(r5, { recursive: true, force: true });
    }
  });

  it('oversized files are binary by their size, without being read (F6)', async () => {
    const { root: r6 } = makeRepo();
    const big = path.join(r6, 'big.txt');
    writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 1));
    const r6Source = new GitCliDiffSource({ root: r6 });
    fsMock.reads.length = 0;
    try {
      const { files } = await r6Source.getDiff({ kind: 'unstaged' });
      expect(files).toEqual([
        { path: 'big.txt', status: 'added', binary: true, hunks: [], untracked: true },
      ]);
      const file = await r6Source.getDiff({ kind: 'file', path: 'big.txt' });
      expect(file.files).toEqual([
        { path: 'big.txt', status: 'modified', binary: true, hunks: [] },
      ]);
      expect(fsMock.reads).not.toContain(big);
    } finally {
      rmSync(r6, { recursive: true, force: true });
    }
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

  it('a merge conflict is reported as unmerged in the unstaged and staged modes (F26)', async () => {
    const { root: rm, git: gm } = makeRepo();
    const put = (rel: string, content: string) => writeFileSync(path.join(rm, rel), content);
    put('conflict.txt', 'line1\nline2\nline3\n');
    put('other.txt', 'keep\n');
    gm('add', '.');
    gm('commit', '-q', '-m', 'base');
    gm('checkout', '-q', '-b', 'feature');
    put('conflict.txt', 'line1\nfeature\nline3\n');
    gm('commit', '-q', '-am', 'feature');
    gm('checkout', '-q', 'main');
    put('conflict.txt', 'line1\nmain\nline3\n');
    gm('commit', '-q', '-am', 'main');
    expect(() => gm('merge', '-q', 'feature')).toThrow(); // stops with the conflict
    put('other.txt', 'keep\nmore\n');
    const merging = new GitCliDiffSource({ root: rm });

    const unstaged = (await merging.getDiff({ kind: 'unstaged' })).files;
    expect(unstaged.map((f) => [f.path, f.unmerged ?? false, f.hunks.length])).toEqual([
      ['conflict.txt', true, 0],
      ['other.txt', false, 1],
    ]);
    const staged = (await merging.getDiff({ kind: 'staged' })).files;
    expect(staged.map((f) => [f.path, f.unmerged ?? false])).toEqual([['conflict.txt', true]]);
    // Against the merge-base git shows the working file, conflict markers and all.
    const branch = (await merging.getDiff({ kind: 'branch' })).files;
    expect(branch.find((f) => f.path === 'conflict.txt')).toMatchObject({ hunks: [{}] });
    expect(branch.find((f) => f.path === 'conflict.txt')!.unmerged).toBeUndefined();
    rmSync(rm, { recursive: true, force: true });
  });

  it('staged: oversized index content is binary (F7)', async () => {
    const { root: r7, git: g7 } = makeRepo();
    writeFileSync(path.join(r7, 'big.txt'), 'x\n'.repeat(1024 * 1024 + 1));
    writeFileSync(path.join(r7, 'edge.txt'), 'x'.repeat(2 * 1024 * 1024));
    writeFileSync(path.join(r7, 'small.txt'), 'small\n');
    g7('add', '.');
    try {
      const { files } = await new GitCliDiffSource({ root: r7 }).getDiff({ kind: 'staged' });
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      expect(byPath['big.txt']).toMatchObject({ status: 'added', binary: true });
      expect(byPath['big.txt']!.newContent).toBeUndefined();
      expect(byPath['edge.txt']!.binary).toBeFalsy();
      expect(byPath['edge.txt']!.newContent).toHaveLength(2 * 1024 * 1024);
      expect(byPath['small.txt']).toMatchObject({ newContent: 'small\n' });
    } finally {
      rmSync(r7, { recursive: true, force: true });
    }
  });

  it('staged: a file named like an index stage (`1:foo`) is read as itself (F10)', async () => {
    const { root: r9, git: g9 } = makeRepo();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: r9,
      input: 'colon\n',
      encoding: 'utf8',
    }).trim();
    // Git for Windows refuses `:` in index paths, so stage `1_foo` and rename it in the index.
    g9('update-index', '--add', '--cacheinfo', `100644,${blob},1_foo`);
    const indexFile = path.join(r9, '.git', 'index');
    const index = readFileSync(indexFile);
    index[index.indexOf('1_foo') + 1] = ':'.charCodeAt(0);
    const body = index.subarray(0, index.length - 20);
    writeFileSync(indexFile, Buffer.concat([body, createHash('sha1').update(body).digest()]));
    try {
      const { files } = await new GitCliDiffSource({ root: r9 }).getDiff({ kind: 'staged' });
      expect(files).toMatchObject([{ path: '1:foo', status: 'added', newContent: 'colon\n' }]);
    } finally {
      rmSync(r9, { recursive: true, force: true });
    }
  });

  it('staged: reads the index with a bounded number of git processes (F7)', async () => {
    const { root: r8, git: g8 } = makeRepo();
    for (let i = 0; i < 40; i++) writeFileSync(path.join(r8, `f${i}.txt`), `file ${i}\n`);
    g8('add', '.');
    Object.assign(execMock, { track: true, inFlight: 0, peak: 0 });
    try {
      const { files } = await new GitCliDiffSource({ root: r8 }).getDiff({ kind: 'staged' });
      expect(files).toHaveLength(40);
      for (const f of files) expect(f.newContent).toBe(`file ${f.path.slice(1, -4)}\n`);
      expect(execMock.peak).toBeGreaterThan(1);
      expect(execMock.peak).toBeLessThanOrEqual(16);
    } finally {
      execMock.track = false;
      rmSync(r8, { recursive: true, force: true });
    }
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

  it('file and selection modes refuse files git ignores; tracked and untracked ones work', async () => {
    const { root: ri, git: gi } = makeRepo();
    const put = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(ri, rel)), { recursive: true });
      writeFileSync(path.join(ri, rel), content);
    };
    try {
      put('.gitignore', '*.local.json\nprivate/\n');
      put('app.ts', 'export const a = 1;\n');
      put('forced.local.json', '{"tracked": true}\n');
      gi('add', '.gitignore', 'app.ts');
      gi('add', '-f', 'forced.local.json');
      gi('commit', '-q', '-m', 'init');
      put('settings.local.json', '{"password": "do-not-send"}\n');
      put('private/notes.md', 'do-not-send\n');
      put('-dash.local.json', 'do-not-send\n');
      put('new.ts', 'export const n = 1;\n');
      const asked: string[] = [];
      const ignoring = new GitCliDiffSource({
        root: ri,
        unsavedText: (abs) => {
          asked.push(abs);
          return undefined;
        },
      });
      for (const rel of ['settings.local.json', 'private/notes.md', '-dash.local.json']) {
        for (const mode of [
          { kind: 'file' as const, path: rel },
          { kind: 'selection' as const, path: rel, startLine: 1, endLine: 1 },
        ]) {
          await expect(ignoring.getDiff(mode), `${mode.kind} ${rel}`).rejects.toSatisfy(
            (e) =>
              isDiffSourceError(e) &&
              e.kind === 'ignored' &&
              e.message === `${rel} is ignored by git, so it isn't reviewed.`,
          );
        }
      }
      // Refused before the file or the editor's text is read.
      expect(asked).toEqual([]);
      expect(fsMock.reads.some((r) => r.includes('settings.local.json'))).toBe(false);

      // Tracked (even when it matches an ignore pattern) and untracked, not ignored files work.
      for (const rel of ['app.ts', 'forced.local.json', 'new.ts']) {
        const { files } = await ignoring.getDiff({ kind: 'file', path: rel });
        expect(files.map((f) => f.path)).toEqual([rel]);
      }
    } finally {
      rmSync(ri, { recursive: true, force: true });
    }
  });

  it('file and selection modes: CRLF is normalized; binary, oversized and missing files', async () => {
    const crlf = await source.getDiff({ kind: 'file', path: 'crlf.txt' });
    expect(crlf.files[0]).toMatchObject({
      status: 'modified',
      binary: false,
      newContent: 'x\nY\n',
    });
    expect(crlf.files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['x', 'Y']);
    const sel = await source.getDiff({
      kind: 'selection',
      path: 'crlf.txt',
      startLine: 2,
      endLine: 2,
    });
    expect(sel.files[0]!.hunks[0]!.lines).toEqual([{ kind: 'add', text: 'Y', newLine: 2 }]);

    const img = await source.getDiff({ kind: 'file', path: 'img.png' });
    expect(img.files).toEqual([{ path: 'img.png', status: 'modified', binary: true, hunks: [] }]);
    write('big.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    try {
      const big = await source.getDiff({ kind: 'file', path: 'big.txt' });
      expect(big.files).toEqual([{ path: 'big.txt', status: 'modified', binary: true, hunks: [] }]);
    } finally {
      rmSync(path.join(root, 'big.txt'));
    }
    await expect(source.getDiff({ kind: 'file', path: 'missing.txt' })).rejects.toSatisfy(
      (e) => isDiffSourceError(e) && e.kind === 'notFound',
    );
  });

  it('file and selection modes review unsaved editor text; the diff modes ignore it (F19)', async () => {
    const asked: string[] = [];
    const buffers: Record<string, string> = {
      'keep.txt': 'zero\r\none\r\nTWO\r\nthree\r\n',
      'img.png': 'text in the editor\0',
      'big.txt': 'y'.repeat(2 * 1024 * 1024 + 1),
    };
    const unsaved = new GitCliDiffSource({
      root,
      unsavedText: (abs) => {
        asked.push(abs);
        return buffers[path.relative(root, abs).split(path.sep).join('/')];
      },
    });

    const file = await unsaved.getDiff({ kind: 'file', path: 'keep.txt' });
    expect(file.files[0]).toMatchObject({
      status: 'modified',
      newContent: 'zero\none\nTWO\nthree\n',
    });
    expect(file.files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual([
      'zero',
      'one',
      'TWO',
      'three',
    ]);
    const sel = await unsaved.getDiff({
      kind: 'selection',
      path: 'keep.txt',
      startLine: 3,
      endLine: 3,
    });
    expect(sel.files[0]!.hunks[0]!.lines).toEqual([{ kind: 'add', text: 'TWO', newLine: 3 }]);
    expect(asked).toContain(path.join(root, 'keep.txt'));

    // Same binary and size rules as the file; a buffer for a file not on disk is used too.
    expect((await unsaved.getDiff({ kind: 'file', path: 'img.png' })).files[0]!.binary).toBe(true);
    expect((await unsaved.getDiff({ kind: 'file', path: 'big.txt' })).files[0]!.binary).toBe(true);
    // The sandbox comes first: an outside path never reaches the host.
    asked.length = 0;
    await expect(unsaved.getDiff({ kind: 'file', path: '../etc/passwd' })).rejects.toSatisfy(
      (e) => isDiffSourceError(e) && e.kind === 'outsideRepo',
    );
    expect(asked).toEqual([]);

    // Diffs are about saved content.
    const { files } = await unsaved.getDiff({ kind: 'unstaged' });
    expect(files.find((f) => f.path === 'keep.txt')!.newContent).toBe('one\nTWO\nthree\n');
    expect(asked).toEqual([]);
  });
});

describe('sandbox + FsWorkspaceTools', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    // A repo: the tools show only the files git lists (untracked ones too).
    ({ root } = makeRepo());
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
    // Names that only start with `..` are inside (F10).
    expect(await resolveInRepo(root, '..config')).toBe(path.join(root, '..config'));
    expect(await resolveInRepo(root, 'src/..d/x.ts')).toBe(path.join(root, 'src', '..d', 'x.ts'));
    await expect(resolveInRepo(root, 'src/../..')).rejects.toSatisfy(isOutside);
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

  it('isInside: `..` names are inside, `..` steps and other drives are not (F10)', () => {
    const base = path.resolve('/repo');
    expect(isInside(base, base)).toBe(true);
    expect(isInside(base, path.join(base, '..config'))).toBe(true);
    expect(isInside(base, path.join(base, '...', 'x'))).toBe(true);
    expect(isInside(base, path.join(base, 'src', 'a.ts'))).toBe(true);
    expect(isInside(base, path.dirname(base))).toBe(false);
    expect(isInside(base, path.join(base, '..', 'other'))).toBe(false);
    expect(isInside(base, path.resolve('/repo2'))).toBe(false);
    if (process.platform === 'win32') {
      expect(isInside('C:\\repo', 'D:\\repo\\x')).toBe(false);
      expect(isInside('C:\\Repo', 'c:\\repo\\X')).toBe(true);
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

  it('grep skips node_modules and searches only the given files; findReferences uses grep', async () => {
    const tools = new FsWorkspaceTools(root);
    const listed = await tools.listFiles();
    expect(listed).toContain('node_modules/x/i.js');
    const hits = await tools.grep('foo\\(\\)', listed);
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      'src/a.ts:1',
      'src/a.ts:2',
      'src/b.ts:2',
    ]);
    expect((await tools.grep('foo', ['src/b.ts'])).every((h) => h.path === 'src/b.ts')).toBe(true);
    expect(await tools.grep('(unclosed', listed)).toEqual([]);
    const refs = await tools.findReferences('src/a.ts', 1, 18);
    expect(refs).toHaveLength(4);
    expect(await tools.getSymbolAt('src/a.ts', 1)).toBeNull();
  });
});
