import { describe, expect, it } from 'vitest';
import { addedFileDiff, parseUnifiedDiff, unquote } from './index';

const MODIFY = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line1
-line2
+line2 changed
+inserted
 line3
 line4
@@ -10,2 +11,2 @@ function x() {
 ten
-eleven
+ELEVEN
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file with line numbers on both sides', () => {
    const { files } = parseUnifiedDiff(MODIFY);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f).toMatchObject({ path: 'src/a.ts', status: 'modified', binary: false });
    expect(f.oldPath).toBeUndefined();
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'line1', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'line2', oldLine: 2 },
      { kind: 'add', text: 'line2 changed', newLine: 2 },
      { kind: 'add', text: 'inserted', newLine: 3 },
      { kind: 'ctx', text: 'line3', oldLine: 3, newLine: 4 },
      { kind: 'ctx', text: 'line4', oldLine: 4, newLine: 5 },
    ]);
    expect(f.hunks[1]!.lines.at(-1)).toEqual({ kind: 'add', text: 'ELEVEN', newLine: 12 });
  });

  it('parses an added file', () => {
    const { files } = parseUnifiedDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`);
    expect(files[0]).toMatchObject({ path: 'new.txt', status: 'added' });
    expect(files[0]!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it('parses a deleted file', () => {
    const { files } = parseUnifiedDiff(`diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`);
    expect(files[0]).toMatchObject({ path: 'old.txt', status: 'deleted' });
    expect(files[0]!.hunks[0]!.lines.every((l) => l.kind === 'del')).toBe(true);
  });

  it('parses a pure rename and a rename with edits', () => {
    const { files } = parseUnifiedDiff(`diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
diff --git a/src/x.ts b/lib/x.ts
similarity index 90%
rename from src/x.ts
rename to lib/x.ts
index 1..2 100644
--- a/src/x.ts
+++ b/lib/x.ts
@@ -1 +1 @@
-a
+b
`);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'b.txt', oldPath: 'a.txt', status: 'renamed' });
    expect(files[0]!.hunks).toEqual([]);
    expect(files[1]).toMatchObject({ path: 'lib/x.ts', oldPath: 'src/x.ts', status: 'renamed' });
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it('parses binary files', () => {
    const { files } = parseUnifiedDiff(`diff --git a/img.png b/img.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/img.png differ
diff --git a/data.bin b/data.bin
index 1..2 100644
GIT binary patch
literal 10
Rcmc~
`);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'img.png', status: 'added', binary: true, hunks: [] });
    expect(files[1]).toMatchObject({ path: 'data.bin', binary: true });
  });

  it('normalizes CRLF and keeps content intact', () => {
    const { files } = parseUnifiedDiff(MODIFY.replace(/\n/g, '\r\n'));
    expect(files[0]!.hunks[0]!.lines[2]).toEqual({
      kind: 'add',
      text: 'line2 changed',
      newLine: 2,
    });
    expect(JSON.stringify(files)).not.toContain('\\r');
  });

  it('handles "No newline at end of file"', () => {
    const { files } = parseUnifiedDiff(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
 a
-b
\\ No newline at end of file
+b
\\ No newline at end of file
`);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2 },
      { kind: 'add', text: 'b', newLine: 2 },
    ]);
  });

  it('does not mistake content lines for headers', () => {
    const { files } = parseUnifiedDiff(`diff --git a/f.md b/f.md
--- a/f.md
+++ b/f.md
@@ -1,2 +1,2 @@
---- not a header
-++ also not
+--- still content
+++++ content too
`);
    expect(files).toHaveLength(1);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual([
      '--- not a header',
      '++ also not',
      '--- still content',
      '++++ content too',
    ]);
  });

  it('handles paths with spaces and quoted unicode paths', () => {
    const { files } = parseUnifiedDiff(`diff --git a/my dir/a b.txt b/my dir/a b.txt
new file mode 100644
--- /dev/null
+++ b/my dir/a b.txt
@@ -0,0 +1 @@
+x
diff --git "a/f\\303\\244.txt" "b/f\\303\\244.txt"
deleted file mode 100644
Binary files "a/f\\303\\244.txt" and /dev/null differ
`);
    expect(files.map((f) => f.path)).toEqual(['my dir/a b.txt', 'fä.txt']);
    expect(files[1]).toMatchObject({ status: 'deleted', binary: true });
  });

  it('parses a mode-only change and a plain (non-git) unified diff', () => {
    const modeOnly = parseUnifiedDiff(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`);
    expect(modeOnly.files[0]).toMatchObject({ path: 'run.sh', status: 'modified', hunks: [] });

    const plain = parseUnifiedDiff(`--- a/one.txt\t2024-01-01
+++ b/one.txt\t2024-01-02
@@ -1 +1 @@
-x
+y
--- two.txt
+++ two.txt
@@ -1 +1,2 @@
 a
+b
`);
    expect(plain.files.map((f) => f.path)).toEqual(['one.txt', 'two.txt']);
  });

  it('empty input gives no files', () => {
    expect(parseUnifiedDiff('')).toEqual({ files: [] });
  });
});

describe('helpers', () => {
  it('unquote handles C escapes', () => {
    expect(unquote('"a\\tb\\"c\\\\"')).toBe('a\tb"c\\');
    expect(unquote('plain')).toBe('plain');
  });

  it('addedFileDiff builds an all-added diff, optionally for a range', () => {
    const f = addedFileDiff('x.ts', 'a\r\nb\r\nc\r\n', { startLine: 2, endLine: 3 });
    expect(f.newContent).toBe('a\nb\nc\n');
    expect(f.hunks[0]).toMatchObject({ newStart: 2, newLines: 2 });
    expect(f.hunks[0]!.lines.map((l) => [l.newLine, l.text])).toEqual([
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(addedFileDiff('b.bin', 'a\0b').binary).toBe(true);
  });
});
