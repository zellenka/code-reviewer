import { MockProvider, type ChatRequest, type MockStep } from '@ai-review/core';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** Stub model: reports the `a + b` bug, with a wrong line number, whenever it's in the diff. */
function reviewer(req: ChatRequest): MockStep {
  const text = JSON.stringify(req.messages);
  const findings = text.includes('return a + b;')
    ? [
        {
          file: 'src/calc.ts',
          startLine: 2,
          endLine: 2,
          severity: 'major',
          category: 'bug',
          title: 'sub() adds instead of subtracting',
          body: 'Use `a - b`.',
          quote: 'return a + b;',
          suggestion: 'return a - b;',
          confidence: 0.95,
        },
      ]
    : [];
  return {
    events: [{ type: 'tool_call', id: 'c1', name: 'report_findings', input: { findings } }],
  };
}

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
    api.diagnostics.clear();
    rmSync(path.join(root, '.codereview.yml'), { force: true });
    api.configs.forget(root);
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
});
