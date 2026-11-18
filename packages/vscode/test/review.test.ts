import {
  MockProvider,
  fingerprint,
  type ChatRequest,
  type Finding,
  type LLMProvider,
  type MockStep,
  type ReviewSnapshot,
} from '@ai-review/core';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import type { ReviewCommandResult } from '../src/review/commands';
import { FixPreviewProvider, previewFix } from '../src/review/fixes';
import { SnapshotStore } from '../src/review/snapshots';
import { FindingStatusStore } from '../src/review/state';

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { name: string; publisher: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const CALC_V1 = 'export function sub(a: number, b: number) {\n  return a - b;\n}\n';
// Line 2 is the bug; three lines are added above it so the model's line number is stale.
const CALC_V2 =
  '// helpers\n\nexport function sub(a: number, b: number) {\n  return a + b;\n}\n\nexport const twice = (n: number) => n * 2;\n';

/** Bugs the stub model knows; each is reported (line 2, often wrong) when its quote is sent. */
const KNOWN_BUGS = [
  {
    file: 'src/calc.ts',
    title: 'sub() adds instead of subtracting',
    quote: 'return a + b;',
    suggestion: 'return a - b;',
  },
  {
    file: 'src/ux-lf.ts',
    title: 'div() multiplies',
    quote: 'return a * b; // lf',
    suggestion: 'return a / b; // lf',
  },
  {
    file: 'src/ux-crlf.ts',
    title: 'div() multiplies (crlf)',
    quote: 'return a * b; // crlf',
    suggestion: 'if (b === 0) throw new Error("b is 0");\nreturn a / b; // crlf',
  },
  {
    file: 'src/ux-track.ts',
    title: 'tracked bug',
    quote: 'return a * b; // track',
    suggestion: 'return a / b; // track',
  },
  {
    file: 'src/ux-dup.ts',
    title: 'duplicated bug',
    quote: 'return a * b; // dup',
    suggestion: 'return a / b; // dup',
    body: 'Fix the operator. ![x](https://example.invalid/leak.png)',
  },
  {
    file: 'src/ux-state.ts',
    title: 'state bug',
    quote: 'return a * b; // state',
    suggestion: 'return a / b; // state',
  },
  {
    file: 'src/ux-shift.ts',
    title: 'shifted bug',
    quote: 'return a * b; // shift',
    suggestion: 'return a / b; // shift',
  },
  {
    file: 'src/ux-edge.ts',
    title: 'edge bug',
    quote: 'return a * b; // edge',
    suggestion: 'return a / b; // edge',
  },
  {
    file: 'src/ux-revise.ts',
    title: 'revised bug',
    quote: 'return a * b; // revise',
    suggestion: 'return a / b; // revise',
    revised: {
      title: 'Division by zero is not handled',
      body: 'Return 0 when b is 0.',
      severity: 'critical',
      suggestion: 'return b === 0 ? 0 : a / b; // revise',
      confidence: 0.8,
    },
  },
  {
    file: 'src/ux-partial.ts',
    title: 'partial quote',
    quote: 'count18',
    suggestion: 'count18 - 1',
  },
  {
    file: 'src/ux-buf.ts',
    title: 'unsaved bug',
    quote: 'return a * b; // buf',
    suggestion: 'return a / b; // buf',
  },
  {
    file: 'src/ux-sel-buf.ts',
    title: 'unsaved selected bug',
    quote: 'return a * b; // sel-buf',
    suggestion: 'return a / b; // sel-buf',
  },
  {
    // The model only sees the key redacted, so that is what it quotes.
    file: 'src/ux-secret.ts',
    title: 'hard-coded key',
    quote: "const key = '[REDACTED:aws-access-key]'; // secret",
    suggestion: 'const key = process.env.KEY; // secret',
  },
];

/** An AWS example key: redacted before anything is sent or stored. */
const SECRET = 'AKIAIOSFODNN7EXAMPLE';

/** When set, the stub words its findings differently (new title, shorter quote, new fingerprint). */
let reword = false;
/** When set, the stub reports the `revised` text of a bug under the same quote (same fingerprint). */
let revise = false;

/** Stub model: reports known bugs found in the diff; answers summary requests with text. */
function reviewer(req: ChatRequest): MockStep {
  const text = JSON.stringify(req.messages);
  if (!req.tools) {
    return {
      events: [{ type: 'text', delta: '## Walkthrough\n- stub summary\n\n## Top risks\n- none' }],
    };
  }
  const findings = KNOWN_BUGS.filter((b) => text.includes(b.quote)).map((b) => ({
    file: b.file,
    startLine: 2,
    endLine: 2,
    severity: 'major',
    category: 'bug',
    title: reword ? `Reworded: ${b.title}` : b.title,
    body: b.body ?? 'Fix the operator.',
    quote: reword ? b.quote.slice(0, -1) : b.quote,
    suggestion: b.suggestion,
    confidence: 0.95,
    ...(revise ? b.revised : {}),
  }));
  return {
    events: [{ type: 'tool_call', id: 'c1', name: 'report_findings', input: { findings } }],
  };
}

/** A held review request: it waits until `release()`, then the stub answers it. */
interface Gate {
  arrived: boolean;
  release: () => void;
  opened: Promise<void>;
  /** Answer even if the review was cancelled meanwhile, as a provider may finish a response in flight. */
  ignoreCancel: boolean;
}

/** Review requests whose diff contains a key wait at its gate. */
const gates = new Map<string, Gate>();

function hold(quote: string, ignoreCancel = false): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const gate: Gate = { arrived: false, release, opened, ignoreCancel };
  gates.set(quote, gate);
  return gate;
}

/** The stub, with review requests held at their gates (see `hold`). */
function gated(inner: MockProvider): LLMProvider {
  return {
    id: inner.id,
    listModels: () => inner.listModels(),
    countTokens: (model, text) => inner.countTokens(model, text),
    async *chat(req) {
      const text = JSON.stringify(req.messages);
      const gate = req.tools ? [...gates].find(([quote]) => text.includes(quote))?.[1] : undefined;
      if (gate) {
        gate.arrived = true;
        await gate.opened;
        if (gate.ignoreCancel) req = { ...req, signal: new AbortController().signal };
      }
      yield* inner.chat(req);
    },
  };
}

const DIV = (tag: string, eol = '\n') =>
  [
    '// math',
    '',
    'export function div(a: number, b: number) {',
    `  return a * b; // ${tag}`,
    '}',
    '',
  ].join(eol);

suite('Review', () => {
  let api: ExtensionApi;
  let root: string;
  let stub: MockProvider;
  const disposables: vscode.Disposable[] = [];
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.activate();
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-ext-')));
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    write('src/calc.ts', CALC_V1);
    write('README.md', '# demo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'feature');
    write('src/notes.md', 'committed on branch\n');
    git('add', '.');
    git('commit', '-q', '-m', 'branch');
    write('src/staged.ts', 'export const s = 1;\n');
    git('add', 'src/staged.ts');
    write('src/calc.ts', CALC_V2);
    write('src/new.ts', 'export const n = 1;\n');
    write('.env', 'API_TOKEN=do-not-send-this\n');
  });

  setup(() => {
    stub = new MockProvider({
      id: 'copilot',
      models: [
        {
          id: 'stub',
          name: 'Stub',
          vendor: 'copilot',
          maxInputTokens: 50_000,
          maxOutputTokens: 4_000,
          supportsTools: true,
        },
      ],
      fallback: reviewer,
    });
    disposables.push(
      api.registry.register('copilot', {
        label: 'Stub',
        provider: gated(stub),
        isAvailable: () => true,
      }),
    );
  });

  teardown(async () => {
    for (const gate of gates.values()) gate.release();
    gates.clear();
    vscode.Disposable.from(...disposables.splice(0)).dispose();
    api.findings.clear();
    // Each test starts without earlier reviews or dismissed findings.
    await api.snapshots.clear();
    await api.statuses.clear();
    rmSync(path.join(root, '.codereview.yml'), { force: true });
    api.configs.forget(root);
    await api.panel.update({ scope: 'unstaged', root: '', base: '' });
    const config = vscode.workspace.getConfiguration('aiReview');
    await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
    await config.update('model', undefined, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(() => {
    // Best effort: on Windows VS Code may still hold handles in the folder.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // left in the temp dir
    }
  });

  test('registers review commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'reviewStaged',
      'reviewUnstaged',
      'reviewBranch',
      'reviewFile',
      'reviewSelection',
    ]) {
      assert.ok(commands.includes(`aiReview.${id}`), id);
    }
  });

  test('produces a diff for each mode on a temp repo', async () => {
    const repo = await api.repos.resolve(root);
    assert.ok(repo);
    const paths = async (mode: Parameters<typeof repo.source.getDiff>[0]) =>
      (await repo.source.getDiff(mode)).files.map((f) => f.path).sort();
    assert.deepStrictEqual(await paths({ kind: 'unstaged' }), [
      '.env',
      'src/calc.ts',
      'src/new.ts',
    ]);
    assert.deepStrictEqual(await paths({ kind: 'staged' }), ['src/staged.ts']);
    assert.deepStrictEqual(await paths({ kind: 'branch' }), [
      '.env',
      'src/calc.ts',
      'src/new.ts',
      'src/notes.md',
      'src/staged.ts',
    ]);
    assert.deepStrictEqual(await paths({ kind: 'file', path: 'README.md' }), ['README.md']);
    const sel = await repo.source.getDiff({
      kind: 'selection',
      path: 'src/calc.ts',
      startLine: 3,
      endLine: 5,
    });
    assert.deepStrictEqual(
      sel.files[0]!.hunks[0]!.lines.map((l) => l.newLine),
      [3, 4, 5],
    );
  });

  test('review unstaged shows diagnostics on the expected lines', async () => {
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewUnstaged',
      { root, silent: true },
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.findings?.length, 1);

    const uri = vscode.Uri.file(path.join(root, 'src', 'calc.ts'));
    const diagnostics = vscode.languages.getDiagnostics(uri);
    assert.strictEqual(diagnostics.length, 1);
    const [d] = diagnostics;
    // Reported at line 2, re-anchored to line 4 (0-based 3).
    assert.strictEqual(d!.range.start.line, 3);
    assert.strictEqual(d!.severity, vscode.DiagnosticSeverity.Warning);
    assert.strictEqual(d!.source, 'AI Review');
    assert.match(d!.message, /adds instead of subtracting/);

    // The secret file never reached the model.
    assert.ok(!JSON.stringify(stub.requests).includes('do-not-send-this'));
    assert.ok(result.result?.skipped.some((s) => s.path === '.env' && s.reason === 'secret'));
  });

  test('review selection only sends the selected lines', async () => {
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewSelection',
      { root, path: 'src/calc.ts', startLine: 7, endLine: 7, silent: true },
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.findings?.length, 0);
    const sent = JSON.stringify(stub.requests[0]!.messages);
    assert.ok(sent.includes('twice'));
    assert.ok(!sent.includes('return a + b;'));
  });

  test('review file of a secret file sends nothing', async () => {
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewFile',
      { root, path: '.env', silent: true },
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.ok(result.result?.skipped.some((s) => s.path === '.env' && s.reason === 'secret'));
    assert.ok(!JSON.stringify(stub.requests).includes('do-not-send-this'));
  });

  test('review file or selection of an untitled document asks for a file', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'const x = 1;\n' });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    try {
      for (const command of ['aiReview.reviewFile', 'aiReview.reviewSelection']) {
        const result = await vscode.commands.executeCommand<ReviewCommandResult>(command, {
          silent: true,
        });
        assert.strictEqual(result.ok, false, command);
        assert.strictEqual(result.message, 'Open a file to review it.', command);
      }
      assert.strictEqual(stub.requests.length, 0);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('.codereview.yml thresholds apply, and invalid config falls back to defaults', async () => {
    write('.codereview.yml', 'severityThreshold: critical\n');
    api.configs.forget(root);
    let result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
      root,
      path: 'src/calc.ts',
      silent: true,
    });
    assert.strictEqual(result.findings?.length, 0);
    assert.deepStrictEqual(result.result?.dropped, [{ reason: 'belowSeverity', count: 1 }]);

    write('.codereview.yml', 'severityThreshold: [broken\n');
    api.configs.forget(root);
    result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
      root,
      path: 'src/calc.ts',
      silent: true,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.findings?.length, 1);
  });

  test('review current file finds the repo from the file path alone', async () => {
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewFile',
      vscode.Uri.file(path.join(root, 'src', 'calc.ts')),
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.findings?.length, 1);
  });

  test('outside a repository gives a clear message, not a crash', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'air-norepo-'));
    try {
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewUnstaged',
        { root: outside, silent: true },
      );
      assert.strictEqual(result.ok, false);
      assert.match(result.message ?? '', /No git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // ---------- Phase 3: review UX ----------

  /** Writes a file, reviews it, and returns the single finding's key. */
  async function reviewOne(rel: string, content: string): Promise<string> {
    write(rel, content);
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewFile',
      {
        root,
        path: rel,
        silent: true,
      },
    );
    assert.strictEqual(result.ok, true, result.message);
    const open = api.findings.open();
    assert.strictEqual(open.length, 1);
    return open[0]!.key;
  }

  const uriOf = (rel: string) => vscode.Uri.file(path.join(root, ...rel.split('/')));
  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  test('comment threads appear on the right range; resolve, reopen and dismiss update them', async () => {
    const key = await reviewOne('src/ux-lf.ts', DIV('lf'));
    const thread = api.threads.threadOf(key);
    assert.ok(thread);
    assert.strictEqual(thread.range?.start.line, 3);
    assert.strictEqual(thread.contextValue, 'open fixable');
    assert.match(
      (thread.comments[0]!.body as vscode.MarkdownString).value,
      /div\\\(\\\) multiplies/,
    );

    await vscode.commands.executeCommand('aiReview.resolveFinding', thread);
    assert.strictEqual(thread.state, vscode.CommentThreadState.Resolved);
    assert.strictEqual(thread.contextValue, 'resolved');
    assert.strictEqual(vscode.languages.getDiagnostics(uriOf('src/ux-lf.ts')).length, 0);

    await vscode.commands.executeCommand('aiReview.reopenFinding', thread);
    assert.strictEqual(thread.state, vscode.CommentThreadState.Unresolved);
    assert.strictEqual(vscode.languages.getDiagnostics(uriOf('src/ux-lf.ts')).length, 1);

    await vscode.commands.executeCommand('aiReview.dismissFinding', key);
    assert.strictEqual(api.threads.threadOf(key), undefined);
    assert.strictEqual(vscode.languages.getDiagnostics(uriOf('src/ux-lf.ts')).length, 0);
  });

  test('apply fix edits the file (LF), marks it resolved, and undo restores it', async () => {
    const key = await reviewOne('src/ux-lf.ts', DIV('lf'));
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-lf.ts'));
    await vscode.window.showTextDocument(doc);

    const outcome = await vscode.commands.executeCommand<{ ok: boolean }>(
      'aiReview.applyFix',
      key,
      {
        silent: true,
      },
    );
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(doc.getText(), DIV('lf').replace('a * b', 'a / b'));
    assert.strictEqual(api.findings.get(key)?.status, 'resolved');
    // Removing the quote on purpose doesn't make the resolved finding outdated.
    await doc.save();
    assert.ok(!api.findings.get(key)?.stale);
    assert.doesNotMatch(api.threads.threadOf(key)?.label ?? '', /outdated/);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(doc.getText(), DIV('lf'));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('apply fix keeps CRLF line endings (via preview)', async () => {
    const key = await reviewOne('src/ux-crlf.ts', DIV('crlf', '\r\n'));
    const outcome = await vscode.commands.executeCommand<{ ok: boolean; applied?: boolean }>(
      'aiReview.previewFix',
      key,
      { silent: true, accept: true },
    );
    assert.strictEqual(outcome.applied, true);
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-crlf.ts'));
    assert.strictEqual(
      doc.getText(),
      DIV('crlf', '\r\n').replace(
        '  return a * b; // crlf',
        '  if (b === 0) throw new Error("b is 0");\r\nreturn a / b; // crlf',
      ),
    );
    // The preview diff was closed.
    const previews = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff);
    assert.strictEqual(previews.length, 0);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('findings follow edits above them; deleting the quoted code marks them stale', async () => {
    const key = await reviewOne('src/ux-track.ts', DIV('track'));
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-track.ts'));
    const editor = await vscode.window.showTextDocument(doc);

    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// a\n// b\n'));
    await until(() => api.findings.get(key)?.startLine === 6);
    assert.strictEqual(api.threads.threadOf(key)?.range?.start.line, 5);
    assert.strictEqual(vscode.languages.getDiagnostics(doc.uri)[0]?.range.start.line, 5);

    await editor.edit((e) => e.delete(doc.lineAt(5).rangeIncludingLineBreak));
    await doc.save();
    await until(() => api.findings.get(key)?.stale === true);
    assert.match(api.threads.threadOf(key)?.label ?? '', /outdated/);
    const outcome = await vscode.commands.executeCommand<{ ok: boolean }>(
      'aiReview.applyFix',
      key,
      {
        silent: true,
      },
    );
    assert.strictEqual(outcome.ok, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('whole lines deleted or inserted right at the start of a finding shift it (F21)', async () => {
    const filler = Array.from({ length: 25 }, (_, i) => `  const x${i} = ${i};`);
    const lines = DIV('edge').split('\n');
    const content = [...lines.slice(0, 3), ...filler, ...lines.slice(3)].join('\n');
    const key = await reviewOne('src/ux-edge.ts', content);
    assert.strictEqual(api.findings.get(key)?.startLine, 29);
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-edge.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    /** Where the finding is when the store first reports a change (before any re-anchoring). */
    const nextPlacement = () =>
      new Promise<number[]>((resolve) => {
        const sub = api.findings.onDidChange(() => {
          sub.dispose();
          const f = api.findings.get(key);
          resolve([f?.startLine ?? -1, f?.endLine ?? -1]);
        });
      });

    try {
      // The 25 lines right above it: the range ends at column 0 of the finding's line.
      let placed = nextPlacement();
      await editor.edit((e) => e.delete(new vscode.Range(3, 0, 28, 0)));
      assert.deepStrictEqual(await placed, [4, 4]);

      // Lines typed or pasted at column 0 of its first line push it down.
      placed = nextPlacement();
      await editor.edit((e) => e.insert(new vscode.Position(3, 0), filler.join('\n') + '\n'));
      assert.deepStrictEqual(await placed, [29, 29]);

      // Pasting over the lines above (ending at column 0 of its line) shifts it by the difference.
      placed = nextPlacement();
      await editor.edit((e) => e.replace(new vscode.Range(3, 0, 28, 0), '  // a\n  // b\n'));
      assert.deepStrictEqual(await placed, [6, 6]);

      // Lines inserted at column 0 of the line below it leave it alone.
      await editor.edit((e) => e.insert(new vscode.Position(6, 0), '  // below\n'));
      assert.deepStrictEqual(
        [api.findings.get(key)?.startLine, api.findings.get(key)?.endLine],
        [6, 6],
      );

      await doc.save();
      // Past the re-anchoring delay: the quote is still found where the finding is.
      await new Promise((r) => setTimeout(r, 600));
      const f = api.findings.get(key);
      assert.deepStrictEqual([f?.startLine, f?.endLine, !!f?.stale], [6, 6, false]);
      assert.strictEqual(doc.lineAt(5).text, '  return a * b; // edge');
      assert.strictEqual(api.threads.threadOf(key)?.range?.start.line, 5);
      assert.strictEqual(vscode.languages.getDiagnostics(doc.uri)[0]?.range.start.line, 5);
    } finally {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('a thread is updated in place: unchanged findings keep it as is, shifts move it, outdated collapses it', async () => {
    const key = await reviewOne('src/ux-shift.ts', DIV('shift'));
    const thread = api.threads.threadOf(key)!;
    const comments = thread.comments;
    assert.strictEqual(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);

    // The same findings again: no new thread and no new comment.
    await api.findings.set(api.findings.session!, api.findings.all());
    assert.strictEqual(api.threads.threadOf(key), thread);
    assert.strictEqual(thread.comments, comments);

    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-shift.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// a\n// b\n'));
    await until(() => api.findings.get(key)?.startLine === 6);
    assert.strictEqual(api.threads.threadOf(key), thread);
    assert.strictEqual(thread.range?.start.line, 5);
    assert.match((thread.comments[0]!.body as vscode.MarkdownString).value, /shifted bug/);

    await editor.edit((e) => e.delete(doc.lineAt(5).rangeIncludingLineBreak));
    await doc.save();
    await until(() => api.findings.get(key)?.stale === true);
    assert.strictEqual(api.threads.threadOf(key), thread);
    assert.match(thread.label ?? '', /outdated/);
    assert.strictEqual(thread.contextValue, 'open');
    assert.strictEqual(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    assert.match(
      (thread.comments[0]!.body as vscode.MarkdownString).value,
      /_Outdated: the code this comment refers to has changed\._/,
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('a re-review that rewords a same-id finding updates its thread, and apply fix uses what it shows', async () => {
    const key = await reviewOne('src/ux-revise.ts', DIV('revise'));
    const thread = api.threads.threadOf(key)!;
    const bodyOf = () => (thread.comments[0]!.body as vscode.MarkdownString).value;
    assert.match(bodyOf(), /Fix the operator/);

    // Sent again in full (no snapshot), the model words the same finding differently.
    await api.snapshots.clear();
    revise = true;
    try {
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewFile',
        { root, path: 'src/ux-revise.ts', silent: true },
      );
      assert.strictEqual(result.ok, true, result.message);
    } finally {
      revise = false;
    }
    const finding = api.findings.get(key);
    assert.strictEqual(finding?.suggestion, 'return b === 0 ? 0 : a / b; // revise');

    // Same key, same thread, new text.
    assert.strictEqual(api.threads.threadOf(key), thread);
    const shown = bodyOf();
    assert.match(shown, /Division by zero is not handled/);
    assert.match(shown, /Return 0 when b is 0\./);
    assert.match(shown, /🔴 Critical/);
    assert.ok(shown.includes(finding.suggestion), shown);
    assert.doesNotMatch(shown, /Fix the operator|return a \/ b; \/\/ revise/);
    assert.match(thread.label ?? '', /critical/);
    assert.match(String(thread.comments[0]!.label), /80% confidence/);
    // The other views show the new text too.
    const [diagnostic] = vscode.languages.getDiagnostics(uriOf('src/ux-revise.ts'));
    assert.match(diagnostic!.message, /Division by zero is not handled/);
    assert.strictEqual(diagnostic!.severity, vscode.DiagnosticSeverity.Error);
    const file = api.tree.getChildren().find((n) => n.kind === 'file');
    const item = api.tree.getTreeItem(api.tree.getChildren(file)[0]!);
    assert.strictEqual(item.label, 'Division by zero is not handled');

    // Apply fix (from the thread) writes the suggestion the thread shows.
    const outcome = await vscode.commands.executeCommand<{ ok: boolean }>(
      'aiReview.applyFix',
      thread,
      { silent: true },
    );
    assert.strictEqual(outcome.ok, true);
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-revise.ts'));
    assert.strictEqual(doc.lineAt(3).text, '  return b === 0 ? 0 : a / b; // revise');
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('an edited finding never jumps to an identical line far away', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`);
    const content = DIV('dup') + [...filler, '  return a * b; // dup', ''].join('\n');
    const key = await reviewOne('src/ux-dup.ts', content);
    assert.strictEqual(api.findings.get(key)?.startLine, 4);
    // Model markdown can't load images.
    const body = (api.threads.threadOf(key)!.comments[0]!.body as vscode.MarkdownString).value;
    assert.match(body, /\\!\[x\]/);

    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-dup.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    // Rewrite the line so even the fuzzy match fails; the identical line 46 must not be used.
    await editor.edit((e) => e.replace(doc.lineAt(3).range, '  throw new Error("todo");'));
    await doc.save();
    await until(() => api.findings.get(key)?.stale === true);
    assert.strictEqual(api.findings.get(key)?.startLine, 4);

    const outcome = await vscode.commands.executeCommand<{ ok: boolean }>(
      'aiReview.applyFix',
      key,
      {
        silent: true,
      },
    );
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(doc.lineAt(45).text, '  return a * b; // dup');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('a fix whose quote is also part of a longer name on its line is refused, not misapplied', async () => {
    const content = '// math\n\nexport function total() {\n  return discount18 + count18;\n}\n';
    const key = await reviewOne('src/ux-partial.ts', content);
    assert.strictEqual(api.findings.get(key)?.startLine, 4);

    for (const command of ['aiReview.applyFix', 'aiReview.previewFix']) {
      const outcome = await vscode.commands.executeCommand<{ ok: boolean; message?: string }>(
        command,
        key,
        { silent: true, accept: true },
      );
      assert.strictEqual(outcome.ok, false, command);
      assert.match(outcome.message ?? '', /more than once on its line, or inside a longer name/);
    }
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-partial.ts'));
    assert.strictEqual(doc.getText(), content);
    // Still open and current: the code is there, it just needs a manual edit.
    assert.strictEqual(api.findings.get(key)?.status, 'open');
    assert.ok(!api.findings.get(key)?.stale);
  });

  test('tree lists findings by file; clicking one reveals its range; summary is shown', async () => {
    const key = await reviewOne('src/ux-lf.ts', DIV('lf'));
    const roots = api.tree.getChildren();
    assert.deepStrictEqual(
      roots.map((n) => n.kind),
      ['summary', 'file', 'details'],
    );
    const items = api.tree.getChildren(roots[1]);
    assert.strictEqual(items.length, 1);
    const item = api.tree.getTreeItem(items[0]!);
    assert.strictEqual(item.command?.command, 'aiReview.revealFinding');

    const editor = await vscode.commands.executeCommand<vscode.TextEditor>(
      'aiReview.revealFinding',
      ...(item.command?.arguments ?? []),
    );
    assert.strictEqual(
      editor.document.uri.fsPath.toLowerCase(),
      uriOf('src/ux-lf.ts').fsPath.toLowerCase(),
    );
    assert.strictEqual(editor.selection.start.line, 3);
    assert.strictEqual(api.findings.get(key)?.startLine, 4);

    assert.match(api.findings.session?.result.summary ?? '', /Walkthrough/);
    const details = api.tree.getChildren(roots[2]).map((n) => api.tree.getTreeItem(n).label);
    assert.ok(details.some((l) => /request/.test(String(l)) || /in ·/.test(String(l))));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('summary can be turned off', async () => {
    await vscode.workspace
      .getConfiguration('aiReview')
      .update('summary', false, vscode.ConfigurationTarget.Global);
    try {
      write('src/ux-lf.ts', DIV('lf'));
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewFile',
        { root, path: 'src/ux-lf.ts', silent: true },
      );
      assert.strictEqual(result.result?.summary, undefined);
      assert.ok(stub.requests.every((r) => r.tools));
    } finally {
      await vscode.workspace
        .getConfiguration('aiReview')
        .update('summary', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('a priced model above the cost threshold needs confirmation', async () => {
    const priced = new MockProvider({
      id: 'anthropic',
      models: [
        {
          id: 'priced',
          name: 'Priced',
          vendor: 'anthropic',
          maxInputTokens: 50_000,
          maxOutputTokens: 4_000,
          supportsTools: true,
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
      ],
      fallback: reviewer,
    });
    disposables.push(
      api.registry.register('anthropic', {
        label: 'Priced',
        provider: priced,
        isAvailable: () => true,
      }),
    );
    const config = vscode.workspace.getConfiguration('aiReview');
    await config.update('provider', 'anthropic', vscode.ConfigurationTarget.Global);
    await config.update('model', 'priced', vscode.ConfigurationTarget.Global);
    await config.update('costConfirmationThreshold', 0, vscode.ConfigurationTarget.Global);
    try {
      const args = { root, path: 'src/calc.ts', silent: true };
      let result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewFile',
        args,
      );
      assert.strictEqual(result.ok, false);
      assert.match(result.message ?? '', /confirmation/);
      assert.strictEqual(priced.requests.length, 0);
      assert.ok(result.estimate?.costUsd && result.estimate.costUsd.high > 0);

      result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
        ...args,
        confirmCost: true,
      });
      assert.strictEqual(result.ok, true, result.message);
      assert.strictEqual(priced.requests.length, result.estimate?.requests);
      assert.match(result.message ?? '', /≈ \$/);
    } finally {
      await config.update(
        'costConfirmationThreshold',
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    }
  });

  test('the AI Review sidebar has the Review panel and the Findings view', () => {
    const contributes = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes as {
      viewsContainers: { activitybar: { id: string; icon: string }[] };
      views: Record<string, { id: string; type?: string }[]>;
    };
    const container = contributes.viewsContainers.activitybar.find((c) => c.id === 'aiReview');
    assert.ok(container, 'activity bar container');
    assert.ok(
      existsSync(path.join(__dirname, '..', '..', container.icon)),
      'activity bar icon exists',
    );
    assert.deepStrictEqual(
      contributes.views.aiReview!.map((v) => [v.id, v.type ?? 'tree']),
      [
        ['aiReview.controls', 'webview'],
        ['aiReview.findings', 'tree'],
      ],
    );
  });

  test('Run Review uses the scope and base branch picked in the panel', async () => {
    await api.panel.update({ scope: 'staged' });
    let result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.runReview', {
      root,
      silent: true,
    });
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual(api.findings.session?.mode, { kind: 'staged' });
    assert.deepStrictEqual(result.result?.reviewedFiles, ['src/staged.ts']);

    await api.panel.update({ scope: 'branch', base: 'main' });
    result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.runReview', {
      root,
      silent: true,
    });
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual(api.findings.session?.mode, { kind: 'branch', base: 'main' });
    assert.ok(result.findings?.some((f) => f.title === KNOWN_BUGS[0]!.title));

    // A base that doesn't exist is reported, not thrown.
    await api.panel.update({ base: 'no-such-branch' });
    result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.runReview', {
      root,
      silent: true,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message ?? '', /no-such-branch/);
    assert.strictEqual((await api.panel.snapshot()).last?.level, 'warn');

    // A later review from any command replaces that error in the panel.
    result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewStaged', {
      root,
      silent: true,
    });
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual((await api.panel.snapshot()).last?.level, 'info');
  });

  test('panel state shows the open file, selection, model and branches', async () => {
    await api.panel.update({ scope: 'selection', root });
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src/calc.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(3, 0, 5, 0);
    const state = await api.panel.snapshot();
    assert.strictEqual(state.scope, 'selection');
    assert.match(state.file ?? '', /calc.ts$/);
    assert.match(state.selection ?? '', /lines 4–5$/);
    assert.strictEqual(state.model.ok, true);
    assert.match(state.model.label, /Stub/);
    assert.strictEqual(state.running, false);
    assert.ok(Array.isArray(state.branches));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('the panel keeps its last error while findings move or change status (F22)', async () => {
    const key = await reviewOne('src/ux-track.ts', DIV('track'));
    const failInPanel = async () => {
      await api.panel.update({ scope: 'branch', base: 'no-such-branch' });
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.runReview',
        { root, silent: true },
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual((await api.panel.snapshot()).last?.level, 'warn');
    };
    const last = async () => (await api.panel.snapshot()).last;

    await failInPanel();
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-track.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    try {
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// a\n// b\n'));
      await until(() => api.findings.get(key)?.startLine === 6);
      assert.match((await last())?.text ?? '', /no-such-branch/, 'after a line shift');
      api.findings.setStatus(key, 'dismissed');
      assert.match((await last())?.text ?? '', /no-such-branch/, 'after dismissing');
    } finally {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }

    // Clear Findings removes it.
    await vscode.commands.executeCommand('aiReview.clearFindings');
    assert.strictEqual(await last(), undefined);

    // So does a review started from any command, as soon as it starts.
    await failInPanel();
    write('src/ux-lf.ts', DIV('lf'));
    const gate = hold('return a * b; // lf');
    const pending = vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
      root,
      path: 'src/ux-lf.ts',
      silent: true,
    });
    await until(() => gate.arrived);
    const running = await api.panel.snapshot();
    gate.release();
    const result = await pending;
    assert.strictEqual(running.running, true);
    assert.strictEqual(running.last, undefined);
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual((await last())?.level, 'info');
  });

  test('the panel lists a branch created after it first listed them, a few seconds later (F22)', async () => {
    // The test repo is outside the workspace: make it the panel's only repository.
    const roots = api.repos.roots;
    api.repos.roots = async () => [root];
    // Move the clock instead of waiting; past the panel's cache times (5 s) to start fresh.
    const now = Date.now;
    let ahead = 6_000;
    Date.now = () => now() + ahead;
    try {
      assert.ok((await api.panel.snapshot()).branches.includes('feature'));
      git('branch', 'f22-new');
      // Cached for a moment: the panel refreshes on every selection change.
      assert.ok(!(await api.panel.snapshot()).branches.includes('f22-new'));
      ahead += 6_000;
      assert.ok((await api.panel.snapshot()).branches.includes('f22-new'));
    } finally {
      git('branch', '-D', 'f22-new');
      // Leave caches that match the repository again for the tests that follow.
      ahead += 6_000;
      await api.panel.snapshot();
      api.repos.roots = roots;
      ahead += 6_000;
      await api.panel.snapshot();
      Date.now = now;
    }
  });

  test('the panel shows double-checking as on when the repo config turns it on', async () => {
    // Asks for the test repo directly: it's outside the workspace, so whether the panel
    // lists it depends on when the Git extension finds it.
    const config = vscode.workspace.getConfiguration('aiReview');
    try {
      assert.strictEqual(await api.panel.verifyOn(root), false);
      write('.codereview.yml', 'review:\n  verify: true\n');
      api.configs.forget(root);
      assert.strictEqual(await api.panel.verifyOn(root), true);
      // An explicit setting wins over the repo config.
      await config.update('verifyFindings', 'off', vscode.ConfigurationTarget.Global);
      assert.strictEqual(await api.panel.verifyOn(root), false);
      await config.update('verifyFindings', 'on', vscode.ConfigurationTarget.Global);
      rmSync(path.join(root, '.codereview.yml'), { force: true });
      api.configs.forget(root);
      assert.strictEqual(await api.panel.verifyOn(root), true);
      // No repository known: only an explicit "on" ticks the box.
      await config.update('verifyFindings', undefined, vscode.ConfigurationTarget.Global);
      assert.strictEqual(await api.panel.verifyOn(''), false);
    } finally {
      await config.update('verifyFindings', undefined, vscode.ConfigurationTarget.Global);
      rmSync(path.join(root, '.codereview.yml'), { force: true });
      api.configs.forget(root);
    }
  });

  test('the panel can be opened from the command palette', async () => {
    await vscode.commands.executeCommand('aiReview.openPanel');
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('aiReview.runReview'));
    assert.ok(commands.includes('aiReview.cancelReview'));
  });

  test('a dismissed finding stays dismissed in the next review, even reworded', async () => {
    const key = await reviewOne('src/ux-state.ts', DIV('state'));
    await vscode.commands.executeCommand('aiReview.dismissFinding', key);
    assert.strictEqual(api.statuses.size, 1);

    // Same finding again (exact fingerprint), after a full re-review.
    await vscode.commands.executeCommand('aiReview.clearFindings');
    let result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
      root,
      path: 'src/ux-state.ts',
      silent: true,
    });
    assert.strictEqual(result.result?.findings.length, 1);
    assert.strictEqual(api.findings.open().length, 0);
    assert.strictEqual(api.findings.all()[0]!.status, 'dismissed');
    assert.strictEqual(vscode.languages.getDiagnostics(uriOf('src/ux-state.ts')).length, 0);

    // Reworded title and a slightly different quote: a new fingerprint, matched fuzzily.
    await vscode.commands.executeCommand('aiReview.clearFindings');
    reword = true;
    try {
      result = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
        root,
        path: 'src/ux-state.ts',
        silent: true,
      });
    } finally {
      reword = false;
    }
    const [reworded] = api.findings.all();
    assert.match(reworded!.title, /^Reworded/);
    assert.notStrictEqual(reworded!.id, key);
    assert.strictEqual(reworded!.status, 'dismissed');

    // Forgetting brings it back.
    await vscode.commands.executeCommand('aiReview.forgetFindingStatus', { silent: true });
    await vscode.commands.executeCommand('aiReview.clearFindings');
    await vscode.commands.executeCommand('aiReview.reviewFile', {
      root,
      path: 'src/ux-state.ts',
      silent: true,
    });
    assert.strictEqual(api.findings.open().length, 1);
  });

  /** In-memory workspace storage that round-trips values through JSON, like VS Code's. */
  const memoryMemento = (): vscode.Memento => {
    const values = new Map<string, unknown>();
    return {
      keys: () => [...values.keys()],
      get: <T>(k: string, d?: T) => (values.has(k) ? (values.get(k) as T) : d),
      update: (k: string, v: unknown) => {
        values.set(k, JSON.parse(JSON.stringify(v ?? null)));
        return Promise.resolve();
      },
    };
  };

  /** A line finding in src/x.ts; the id stands in for the fingerprint of the quote. */
  const statusFinding = (id: string, quote: string, category: Finding['category'] = 'bug') => ({
    id,
    file: 'src/x.ts',
    startLine: 1,
    endLine: 1,
    anchor: 'line' as const,
    severity: 'major' as const,
    category,
    title: 't',
    body: '',
    quote,
    confidence: 1,
  });

  test('dismissed state is saved in workspace storage and read back after a reload', async () => {
    const memento = memoryMemento();
    const finding = statusFinding('abc', 'const total = price * quantity;');
    await new FindingStatusStore(memento).set(root, finding, 'dismissed');
    const reloaded = new FindingStatusStore(memento);
    assert.strictEqual(reloaded.lookup(root, finding), 'dismissed');
    assert.strictEqual(
      reloaded.lookup(root, {
        ...finding,
        id: 'other',
        quote: 'const total = price  * quantity ;',
      }),
      'dismissed',
    );
    assert.strictEqual(
      reloaded.lookup(root, { ...finding, id: 'x', category: 'security' }),
      undefined,
    );
    assert.strictEqual(reloaded.lookup(path.join(root, 'other'), finding), undefined);
  });

  test('a finding re-reported with a slightly different quote keeps its status, dismissed or resolved', async () => {
    for (const status of ['dismissed', 'resolved'] as const) {
      const memento = memoryMemento();
      const finding = statusFinding('base', 'const total = price * quantity;\nreturn total;');
      await new FindingStatusStore(memento).set(root, finding, status);
      const store = new FindingStatusStore(memento);
      const variants = [
        // Same fingerprint, e.g. a reworded title.
        finding,
        // Other spacing, a little less of the same code, or line numbers / diff markers copied.
        statusFinding('spaced', '  const total =  price * quantity;\n  return total;'),
        statusFinding('shorter', 'const total = price * quantity;\nreturn total'),
        statusFinding('marked', '+const total = price * quantity;\n+return total;'),
        statusFinding('numbered', '10 + const total = price * quantity;\n11 + return total;'),
      ];
      for (const v of variants) assert.strictEqual(store.lookup(root, v), status, v.id);
      assert.strictEqual(
        store.lookup(root, { ...finding, id: 'x', category: 'security' }),
        undefined,
      );
      assert.strictEqual(store.lookup(root, { ...finding, id: 'y', file: 'src/y.ts' }), undefined);

      // Reopening the re-reported finding forgets the stored one.
      await store.set(root, variants[2]!, 'open');
      assert.strictEqual(store.lookup(root, finding), undefined);
      assert.strictEqual(new FindingStatusStore(memento).size, 0);
    }

    // A whole-file finding's quote isn't anchored to the code: a misquote still matches.
    const fileFinding = {
      ...statusFinding('file', 'import { query, transaction } from "./db";'),
      anchor: 'file' as const,
    };
    const misquoted = 'import { query, transactions } from "./db";';
    const fileStore = new FindingStatusStore(memoryMemento());
    await fileStore.set(root, fileFinding, 'dismissed');
    assert.strictEqual(
      fileStore.lookup(root, { ...fileFinding, id: 'file2', quote: misquoted }),
      'dismissed',
    );

    // Entries saved before quotes were stored without copied +/- markers still match.
    const oldMemento = memoryMemento();
    await new FindingStatusStore(oldMemento).set(root, statusFinding('old', 'x'), 'resolved');
    const [saved] = oldMemento.get<{ quote: string }[]>('aiReview.findingStatus.v1')!;
    await oldMemento.update('aiReview.findingStatus.v1', [
      { ...saved, quote: '+ await db.query(sqlA, params);' },
    ]);
    assert.strictEqual(
      new FindingStatusStore(oldMemento).lookup(
        root,
        statusFinding('new', 'await db.query(sqlA, params);'),
      ),
      'resolved',
    );

    const store = new FindingStatusStore(memoryMemento());
    await store.set(root, statusFinding('a', 'const a = 1;'), 'dismissed');
    await store.set(root, statusFinding('b', 'const b = 2;'), 'resolved');
    assert.strictEqual(await store.clear(), 2);
    assert.strictEqual(store.lookup(root, statusFinding('a', 'const a = 1;')), undefined);
  });

  // Similar code on two lines, e.g. two queries: two findings, not one reported twice.
  const queryA = statusFinding('fp-a', 'await db.query(sqlA, params);');
  const queryB = statusFinding('fp-b', 'await db.query(sqlB, params);');

  for (const status of ['dismissed', 'resolved'] as const) {
    test(`a ${status} finding does not hide a new one on a similar line (F30)`, async () => {
      const store = new FindingStatusStore(memoryMemento());
      await store.set(root, queryA, status);
      assert.strictEqual(store.lookup(root, queryA), status);
      assert.strictEqual(store.lookup(root, queryB), undefined);
    });
  }

  test('setting or reopening a finding leaves the status of a similar line alone (F30)', async () => {
    const [a, b] = [queryA, queryB];
    const memento = memoryMemento();
    const store = new FindingStatusStore(memento);
    await store.set(root, a, 'dismissed');
    await store.set(root, b, 'resolved');
    assert.strictEqual(store.lookup(root, a), 'dismissed');
    assert.strictEqual(store.lookup(root, b), 'resolved');
    await store.set(root, b, 'open');
    const reloaded = new FindingStatusStore(memento);
    assert.strictEqual(reloaded.lookup(root, a), 'dismissed');
    assert.strictEqual(reloaded.lookup(root, b), undefined);
  });

  // ---------- Secrets in stored findings (F33) ----------

  const REAL_KEY = `const key = '${SECRET}';`;
  const REDACTED_KEY = "const key = '[REDACTED:aws-access-key]';";
  /** A finding on a line with a secret as a review reports it: real code, redacted copy, id of that. */
  const secretFinding = (real = REAL_KEY, redacted = REDACTED_KEY) =>
    ({
      ...statusFinding(fingerprint('src/x.ts', 'security', redacted), real, 'security'),
      redactedQuote: redacted,
    }) as Finding;
  const storedJson = (memento: vscode.Memento, key: string) => JSON.stringify(memento.get(key));

  test('a dismissed finding on a secret is stored redacted and stays dismissed (F33)', async () => {
    const memento = memoryMemento();
    const finding = secretFinding();
    await new FindingStatusStore(memento).set(root, finding, 'dismissed');
    const saved = storedJson(memento, 'aiReview.findingStatus.v1');
    assert.ok(!saved.includes(SECRET), saved);
    assert.ok(saved.includes('[REDACTED:aws-access-key]'), saved);

    const reloaded = new FindingStatusStore(memento);
    assert.strictEqual(reloaded.lookup(root, finding), 'dismissed');
    // Quoted with other spacing (another id): matched fuzzily, on the redacted code.
    const spaced = secretFinding(
      `  const key =  '${SECRET}';`,
      "  const key =  '[REDACTED:aws-access-key]';",
    );
    assert.strictEqual(reloaded.lookup(root, { ...spaced, id: 'other' }), 'dismissed');
    // Other code on a similar line is another finding.
    const other = secretFinding(
      `const keys = '${SECRET}';`,
      "const keys = '[REDACTED:aws-access-key]';",
    );
    assert.strictEqual(reloaded.lookup(root, other), undefined);
  });

  test('statuses saved with a secret by an older version are rewritten redacted and still match (F33)', async () => {
    const memento = memoryMemento();
    // What an older version stored: the real code, and an id hashed from it.
    const oldId = fingerprint('src/x.ts', 'security', REAL_KEY);
    await new FindingStatusStore(memento).set(
      root,
      statusFinding(oldId, REAL_KEY, 'security'),
      'dismissed',
    );
    assert.ok(storedJson(memento, 'aiReview.findingStatus.v1').includes(SECRET));

    const store = new FindingStatusStore(memento);
    const saved = storedJson(memento, 'aiReview.findingStatus.v1');
    assert.ok(!saved.includes(SECRET), saved);
    assert.ok(!saved.includes(oldId), saved);
    assert.strictEqual(store.lookup(root, secretFinding()), 'dismissed');
    assert.strictEqual(store.size, 1);
  });

  test('snapshots saved with a secret by an older version are dropped (F33)', async () => {
    const memento = memoryMemento();
    const snapshot = (quote: string): ReviewSnapshot => ({
      version: 1,
      key: 'k',
      hunks: {},
      findings: [statusFinding('id', quote)],
      findingHunks: [null],
    });
    const old = new SnapshotStore(memento);
    await old.set(root, { kind: 'unstaged' }, snapshot(REAL_KEY));
    await old.set(root, { kind: 'staged' }, snapshot('const a = 1;'));
    await old.set(
      root,
      { kind: 'branch', base: 'main' },
      {
        ...snapshot(REDACTED_KEY),
        findings: [secretFinding(REDACTED_KEY)],
      },
    );

    const reloaded = new SnapshotStore(memento);
    assert.strictEqual(reloaded.get(root, { kind: 'unstaged' }), undefined);
    assert.ok(reloaded.get(root, { kind: 'staged' }));
    assert.ok(reloaded.get(root, { kind: 'branch', base: 'main' }));
    const saved = storedJson(memento, 'aiReview.reviewSnapshots.v1');
    assert.ok(!saved.includes(SECRET), saved);
  });

  test('stored snapshots with damaged hunks are ignored (F34)', async () => {
    const memento = memoryMemento();
    const snapshot = (hunks: unknown) =>
      ({
        version: 1,
        key: 'k',
        hunks,
        findings: [statusFinding('id', 'const a = 1;')],
        findingHunks: [null],
      }) as ReviewSnapshot;
    const store = new SnapshotStore(memento);
    await store.set(root, { kind: 'unstaged' }, snapshot({ 'src/x.ts': ['h1'] }));
    await store.set(root, { kind: 'staged' }, snapshot(undefined));
    await store.set(root, { kind: 'branch', base: 'main' }, snapshot({ 'src/x.ts': 5 }));
    await store.set(root, { kind: 'file', path: 'src/x.ts' }, snapshot({ 'src/x.ts': [1] }));

    const reloaded = new SnapshotStore(memento);
    assert.ok(reloaded.get(root, { kind: 'unstaged' }));
    assert.strictEqual(reloaded.get(root, { kind: 'staged' }), undefined);
    assert.strictEqual(reloaded.get(root, { kind: 'branch', base: 'main' }), undefined);
    assert.strictEqual(reloaded.get(root, { kind: 'file', path: 'src/x.ts' }), undefined);
  });

  test('a dismissed finding on a secret stays dismissed through incremental and full re-reviews (F33)', async () => {
    const rel = 'src/ux-secret.ts';
    try {
      const key = await reviewOne(rel, `// keys\n\nconst key = '${SECRET}'; // secret\n`);
      // In memory the finding has the real code: it is placed and fixed by it.
      assert.ok(api.findings.get(key)!.quote.includes(SECRET));
      await vscode.commands.executeCommand('aiReview.dismissFinding', key);
      const stored = api.snapshots.get(root, { kind: 'file', path: rel });
      assert.ok(stored);
      assert.ok(!JSON.stringify(stored).includes(SECRET), JSON.stringify(stored));

      const review = () =>
        vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
          root,
          path: rel,
          silent: true,
        });
      // Nothing changed: carried over from the snapshot, with the real code again.
      const before = stub.requests.length;
      let result = await review();
      assert.strictEqual(result.result?.incremental?.carried, 1);
      assert.strictEqual(stub.requests.slice(before).filter((r) => r.tools).length, 0);
      assert.ok(result.findings?.[0]?.quote.includes(SECRET));
      assert.strictEqual(api.findings.all()[0]!.status, 'dismissed');
      assert.strictEqual(api.findings.open().length, 0);

      // Clear Findings starts over: reviewed again, still dismissed.
      await vscode.commands.executeCommand('aiReview.clearFindings');
      result = await review();
      assert.strictEqual(result.result?.incremental, undefined);
      assert.strictEqual(result.findings?.length, 1);
      assert.strictEqual(api.findings.all()[0]!.status, 'dismissed');
      assert.strictEqual(api.findings.open().length, 0);
    } finally {
      rmSync(path.join(root, rel), { force: true });
    }
  });

  test('re-review after a one-line edit sends one chunk and keeps the other findings', async () => {
    const first = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewUnstaged',
      { root, silent: true },
    );
    assert.strictEqual(first.ok, true, first.message);
    // Earlier tests leave untracked files with bugs, so count rather than assume.
    const found = first.findings?.length ?? 0;
    assert.ok(found >= 1);
    const before = stub.requests.length;

    write('src/new.ts', 'export const n = 2;\n');
    try {
      const second = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewUnstaged',
        { root, silent: true },
      );
      assert.strictEqual(second.ok, true, second.message);
      const reviews = stub.requests.slice(before).filter((r) => r.tools);
      assert.strictEqual(reviews.length, 1);
      assert.strictEqual(second.result?.chunks.total, 1);
      const sent = JSON.stringify(reviews[0]!.messages);
      assert.ok(sent.includes('export const n = 2;'));
      assert.ok(!sent.includes('return a + b;'));
      assert.strictEqual(second.result?.incremental?.newHunks, 1);
      assert.strictEqual(second.result?.incremental?.carried, found);
      // The other findings (incl. calc.ts) were carried over and stay on the right line.
      assert.strictEqual(second.findings?.length, found);
      assert.strictEqual(
        vscode.languages.getDiagnostics(uriOf('src/calc.ts'))[0]?.range.start.line,
        3,
      );

      // Clear Findings starts over: everything is sent again.
      await vscode.commands.executeCommand('aiReview.clearFindings');
      const mark = stub.requests.length;
      const third = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewUnstaged',
        { root, silent: true },
      );
      assert.strictEqual(third.result?.incremental, undefined);
      assert.ok(
        stub.requests
          .slice(mark)
          .some((r) => r.tools && JSON.stringify(r.messages).includes('return a + b;')),
      );
    } finally {
      write('src/new.ts', 'export const n = 1;\n');
    }
  });

  // ---------- Unsaved editor changes (F19) ----------

  /** What the review requests (not the summary) sent to the model. */
  const sentForReview = (from = 0) =>
    JSON.stringify(
      stub.requests
        .slice(from)
        .filter((r) => r.tools)
        .map((r) => r.messages),
    );
  const revertAndClose = async (doc: vscode.TextDocument) => {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  };

  test('review file of a document with unsaved edits reviews the editor text (F19)', async () => {
    write('src/ux-buf.ts', DIV('clean'));
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-buf.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    try {
      // Unsaved: two lines above the function, and a bug only the editor has.
      await editor.edit((e) => {
        e.insert(new vscode.Position(0, 0), '// a\n// b\n');
        e.replace(doc.lineAt(3).range, '  return a * b; // buf');
      });
      assert.ok(doc.isDirty);
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewFile',
        { root, path: 'src/ux-buf.ts', silent: true },
      );
      assert.strictEqual(result.ok, true, result.message);
      const sent = sentForReview();
      assert.ok(sent.includes('     6 +   return a * b; // buf'), sent);
      assert.ok(!sent.includes('// clean'));
      // Anchored on the editor's line, as shown.
      assert.deepStrictEqual(
        result.findings?.map((f) => [f.title, f.startLine, !!f.stale]),
        [['unsaved bug', 6, false]],
      );
      assert.strictEqual(vscode.languages.getDiagnostics(doc.uri)[0]?.range.start.line, 5);
      assert.strictEqual(readFileSync(path.join(root, 'src/ux-buf.ts'), 'utf8'), DIV('clean'));
    } finally {
      await revertAndClose(doc);
    }

    // The snapshot holds the editor text: the file on disk is a different hunk, sent again.
    const mark = stub.requests.length;
    const again = await vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
      root,
      path: 'src/ux-buf.ts',
      silent: true,
    });
    assert.strictEqual(again.ok, true, again.message);
    assert.ok(sentForReview(mark).includes('     4 +   return a * b; // clean'));
    assert.deepStrictEqual(again.result?.incremental, {
      newHunks: 1,
      reusedHunks: 0,
      carried: 0,
    });
    assert.deepStrictEqual(again.findings, []);
  });

  test('review selection of a document with unsaved edits sends the selected editor lines (F19)', async () => {
    write('src/ux-sel-buf.ts', DIV('plain'));
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-sel-buf.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    try {
      await editor.edit((e) => {
        e.insert(new vscode.Position(0, 0), '// a\n// b\n// c\n');
        e.replace(doc.lineAt(3).range, '  return a * b; // sel-buf');
      });
      // Line 7 in the editor (line 4 on disk).
      editor.selection = new vscode.Selection(6, 0, 7, 0);
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewSelection',
        { root, silent: true },
      );
      assert.strictEqual(result.ok, true, result.message);
      assert.deepStrictEqual(api.findings.session?.mode, {
        kind: 'selection',
        path: 'src/ux-sel-buf.ts',
        startLine: 7,
        endLine: 7,
      });
      const sent = sentForReview();
      assert.ok(sent.includes('     7 +   return a * b; // sel-buf'), sent);
      assert.ok(!sent.includes('export function div'));
      assert.ok(!sent.includes('// plain'));
      assert.deepStrictEqual(
        result.findings?.map((f) => [f.title, f.startLine]),
        [['unsaved selected bug', 7]],
      );
    } finally {
      await revertAndClose(doc);
    }
  });

  test('unsaved edits get the same secret handling: secret files are refused, keys redacted (F19)', async () => {
    const env = await vscode.workspace.openTextDocument(uriOf('.env'));
    write('src/ux-key.ts', DIV('nokey'));
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-key.ts'));
    try {
      const envEditor = await vscode.window.showTextDocument(env);
      await envEditor.edit((e) =>
        e.insert(new vscode.Position(0, 0), 'TYPED_TOKEN=typed-but-not-saved\n'),
      );
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((e) => {
        e.insert(new vscode.Position(0, 0), 'const id = "AKIAIOSFODNN7EXAMPLE";\n');
        e.replace(doc.lineAt(3).range, '  return a * b; // key');
      });
      assert.ok(env.isDirty && doc.isDirty);

      const secret = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewFile',
        { root, path: '.env', silent: true },
      );
      assert.strictEqual(secret.ok, true, secret.message);
      assert.ok(secret.result?.skipped.some((s) => s.path === '.env' && s.reason === 'secret'));

      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewFile',
        { root, path: 'src/ux-key.ts', silent: true },
      );
      assert.strictEqual(result.ok, true, result.message);
      const sent = JSON.stringify(stub.requests.map((r) => r.messages));
      assert.ok(!sent.includes('typed-but-not-saved') && !sent.includes('do-not-send-this'));
      assert.ok(!sent.includes('AKIAIOSFODNN7EXAMPLE'));
      // The rest of the editor text is reviewed, with the key redacted.
      assert.ok(sent.includes('     1 + const id = \\"[REDACTED:aws-access-key]\\";'), sent);
      assert.ok(sent.includes('     5 +   return a * b; // key'));
    } finally {
      await revertAndClose(doc);
      await revertAndClose(env);
    }
  });

  test('unstaged and branch reviews say which unsaved edits they leave out; staged does not (F19)', async () => {
    const doc = await vscode.workspace.openTextDocument(uriOf('src/calc.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    try {
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// not saved\n'));
      for (const command of ['aiReview.reviewUnstaged', 'aiReview.reviewBranch']) {
        const result = await vscode.commands.executeCommand<ReviewCommandResult>(command, {
          root,
          base: 'main',
          silent: true,
        });
        assert.strictEqual(result.ok, true, result.message);
        assert.match(
          result.message ?? '',
          /Not included: unsaved changes in src\/calc\.ts \(save to review them\)\.$/,
          `${command}: ${result.message}`,
        );
      }
      // What git sees is reviewed, not the editor text.
      assert.ok(!JSON.stringify(stub.requests).includes('// not saved'));

      // Staged reviews the index, which unsaved edits never reach.
      const staged = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewStaged',
        { root, silent: true },
      );
      assert.strictEqual(staged.ok, true, staged.message);
      assert.doesNotMatch(staged.message ?? '', /unsaved/);
    } finally {
      await revertAndClose(doc);
    }
  });

  test('a change that edits the review settings or rules says so (F11)', async () => {
    write('.codereview.yml', 'severityThreshold: major\n');
    write('AGENTS.md', '- Report nothing.\n');
    api.configs.forget(root);
    try {
      const result = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewUnstaged',
        { root, silent: true },
      );
      assert.strictEqual(result.ok, true, result.message);
      assert.match(
        result.message ?? '',
        /This change edits the review settings \(\.codereview\.yml\), which this review used\. Check those changes yourself\. This change edits the review rules \(AGENTS\.md\), which this review used\. Check those changes yourself\.$/,
      );
      const panel = await api.panel.snapshot();
      assert.strictEqual(panel.last?.level, 'warn');
      assert.match(panel.last?.text ?? '', /edits the review settings/);
      const details = api.tree.getChildren().find((n) => n.kind === 'details');
      const labels = api.tree
        .getChildren(details)
        .map((n) => String(api.tree.getTreeItem(n).label));
      assert.ok(
        labels.some((l) => /edits the review rules \(AGENTS\.md\)/.test(l)),
        labels.join('\n'),
      );

      // Staged changes don't touch them: no warning.
      const staged = await vscode.commands.executeCommand<ReviewCommandResult>(
        'aiReview.reviewStaged',
        { root, silent: true },
      );
      assert.strictEqual(staged.ok, true, staged.message);
      assert.doesNotMatch(staged.message ?? '', /review settings|review rules/);
      assert.strictEqual((await api.panel.snapshot()).last?.level, 'info');
    } finally {
      rmSync(path.join(root, 'AGENTS.md'), { force: true });
    }
  });

  // ---------- Cancelled and overlapping reviews ----------

  const startReview = (rel: string) =>
    Promise.resolve(
      vscode.commands.executeCommand<ReviewCommandResult>('aiReview.reviewFile', {
        root,
        path: rel,
        silent: true,
      }),
    );
  const titles = () => api.findings.all().map((f) => f.title);
  const isRunning = async () => (await api.panel.snapshot()).running;

  test('a new review replaces the previous findings', async () => {
    await reviewOne('src/ux-track.ts', DIV('track'));
    await reviewOne('src/ux-lf.ts', DIV('lf'));
    assert.deepStrictEqual(titles(), ['div() multiplies']);
    assert.deepStrictEqual(api.findings.session?.mode, { kind: 'file', path: 'src/ux-lf.ts' });
  });

  test('cancelling keeps the findings of finished parts; the running state follows the review', async () => {
    await reviewOne('src/ux-track.ts', DIV('track'));
    write('src/ux-lf.ts', DIV('lf'));
    const gate = hold('return a * b; // lf', true);
    assert.strictEqual(await isRunning(), false);
    const pending = startReview('src/ux-lf.ts');
    await until(() => gate.arrived);
    assert.strictEqual(await isRunning(), true);

    await vscode.commands.executeCommand('aiReview.cancelReview');
    gate.release();
    const result = await pending;
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.result?.cancelled, true);
    assert.strictEqual(result.result?.chunks.completed, 1);
    assert.match(result.message ?? '', /^Cancelled\. 1 finding\(s\) .*\(from finished parts\)$/);
    // The finished part's findings replace the previous review's.
    assert.deepStrictEqual(titles(), ['div() multiplies']);
    assert.strictEqual(api.findings.session?.result.cancelled, true);
    // Not complete, so the next review of this scope doesn't build on it.
    assert.strictEqual(api.snapshots.get(root, { kind: 'file', path: 'src/ux-lf.ts' }), undefined);
    assert.strictEqual(await isRunning(), false);
  });

  test('cancelling before any part finishes keeps the previous findings (F20)', async () => {
    await reviewOne('src/ux-track.ts', DIV('track'));
    const session = api.findings.session;
    write('src/ux-lf.ts', DIV('lf'));
    const unchanged = (result: ReviewCommandResult, step: string) => {
      assert.doesNotMatch(result.message ?? '', /no issues found/, `${step}: ${result.message}`);
      assert.deepStrictEqual(titles(), ['tracked bug'], step);
      assert.strictEqual(api.findings.session, session, step);
    };

    // 1. While the changes are collected ("collecting changes…").
    const resolve = api.repos.resolve;
    let entered = false;
    let proceed!: () => void;
    const resolving = new Promise<void>((r) => (proceed = r));
    api.repos.resolve = async (target) => {
      entered = true;
      await resolving;
      return resolve.call(api.repos, target);
    };
    let result: ReviewCommandResult;
    try {
      const pending = startReview('src/ux-lf.ts');
      await until(() => entered);
      await vscode.commands.executeCommand('aiReview.cancelReview');
      proceed();
      result = await pending;
    } finally {
      api.repos.resolve = resolve;
    }
    assert.ok(!stub.requests.some((r) => JSON.stringify(r.messages).includes('// lf')));
    unchanged(result, 'collecting');

    // 2. While the only part is with the model.
    const gate = hold('return a * b; // lf');
    const pending = startReview('src/ux-lf.ts');
    await until(() => gate.arrived);
    await vscode.commands.executeCommand('aiReview.cancelReview');
    gate.release();
    result = await pending;
    unchanged(result, 'in flight');
    assert.strictEqual(await isRunning(), false);
  });

  test('a review started while another runs: the first one finishing late never replaces it (F20)', async () => {
    write('src/ux-lf.ts', DIV('lf'));
    write('src/ux-track.ts', DIV('track'));
    const gate = hold('return a * b; // lf', true);
    const first = startReview('src/ux-lf.ts');
    await until(() => gate.arrived);

    // From the command palette or a keybinding: only the panel's button is guarded.
    const second = await startReview('src/ux-track.ts');
    assert.strictEqual(second.ok, true, second.message);
    assert.deepStrictEqual(titles(), ['tracked bug']);

    // The first review's model call ends after all, with a finding.
    gate.release();
    await first;
    assert.deepStrictEqual(titles(), ['tracked bug']);
    assert.deepStrictEqual(api.findings.session?.mode, { kind: 'file', path: 'src/ux-track.ts' });
    assert.strictEqual(api.findings.session?.result.cancelled, false);
    assert.strictEqual(api.snapshots.get(root, { kind: 'file', path: 'src/ux-lf.ts' }), undefined);
    assert.strictEqual(await isRunning(), false);
  });

  test('a superseded review ending first neither writes findings nor clears the running state (F20)', async () => {
    await reviewOne('src/ux-state.ts', DIV('state'));
    write('src/ux-lf.ts', DIV('lf'));
    write('src/ux-track.ts', DIV('track'));
    const a = hold('return a * b; // lf', true);
    const b = hold('return a * b; // track');
    const first = startReview('src/ux-lf.ts');
    await until(() => a.arrived);
    const second = startReview('src/ux-track.ts');
    await until(() => b.arrived);

    a.release();
    await first;
    // The second review is still running: the first one's cleanup leaves that alone,
    // and its findings don't replace the previous ones.
    assert.strictEqual(await isRunning(), true);
    assert.deepStrictEqual(titles(), ['state bug']);

    b.release();
    const result = await second;
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual(titles(), ['tracked bug']);
    assert.strictEqual(await isRunning(), false);
  });

  test('overlapping store updates never mix their findings; the last one started wins (F20)', async () => {
    await reviewOne('src/ux-lf.ts', DIV('lf'));
    const session = api.findings.session!;
    const finding = (id: string, file: string, quote: string): Finding => ({
      id,
      file,
      startLine: 1,
      endLine: 1,
      anchor: 'line',
      severity: 'major',
      category: 'bug',
      title: id,
      body: '',
      quote,
      confidence: 1,
    });
    const x = [finding('x', 'src/calc.ts', 'return a + b;')];
    const y = [finding('y', 'README.md', '# demo')];
    // Each update opens its files' documents first, so the two overlap.
    await Promise.all([
      api.findings.set({ ...session, finishedAt: new Date(1) }, x),
      api.findings.set({ ...session, finishedAt: new Date(2) }, y),
    ]);
    assert.deepStrictEqual(
      api.findings.all().map((f) => f.id),
      ['y'],
    );
    assert.strictEqual(api.findings.session?.finishedAt.getTime(), 2);

    // Clearing while an update is under way wins too.
    const pending = api.findings.set(session, x);
    api.findings.clear();
    await pending;
    assert.deepStrictEqual(api.findings.all(), []);
    assert.strictEqual(api.findings.session, undefined);
  });

  test('accepting a preview never applies a fix that changed while it was shown', async () => {
    const key = await reviewOne('src/ux-revise.ts', DIV('revise'));
    const doc = await vscode.workspace.openTextDocument(uriOf('src/ux-revise.ts'));
    try {
      const outcome = await previewFix(api.findings, new FixPreviewProvider(), key, async () => {
        // While the question is open, a re-review changes the suggestion.
        await api.snapshots.clear();
        revise = true;
        try {
          await startReview('src/ux-revise.ts');
        } finally {
          revise = false;
        }
        assert.strictEqual(
          api.findings.get(key)?.suggestion,
          'return b === 0 ? 0 : a / b; // revise',
        );
        return true;
      });
      assert.strictEqual(outcome.ok, false);
      assert.match(outcome.message ?? '', /changed while the preview was open/);
      assert.strictEqual(doc.getText(), DIV('revise'));
      assert.strictEqual(api.findings.get(key)?.status, 'open');
    } finally {
      if (doc.isDirty) {
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
  });
});
