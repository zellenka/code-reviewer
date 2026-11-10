import { MockProvider, type ChatRequest, type MockStep } from '@ai-review/core';
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
];

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
    title: b.title,
    body: b.body ?? 'Fix the operator.',
    quote: b.quote,
    suggestion: b.suggestion,
    confidence: 0.95,
  }));
  return {
    events: [{ type: 'tool_call', id: 'c1', name: 'report_findings', input: { findings } }],
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
      api.registry.register('copilot', { label: 'Stub', provider: stub, isAvailable: () => true }),
    );
  });

  teardown(async () => {
    vscode.Disposable.from(...disposables.splice(0)).dispose();
    api.findings.clear();
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

  test('the panel can be opened from the command palette', async () => {
    await vscode.commands.executeCommand('aiReview.openPanel');
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('aiReview.runReview'));
    assert.ok(commands.includes('aiReview.cancelReview'));
  });
});
