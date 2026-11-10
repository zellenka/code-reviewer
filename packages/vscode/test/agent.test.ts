import {
  MockProvider,
  createReviewTools,
  noopLogger,
  type AgentTool,
  type ChatRequest,
  type MockStep,
} from '@ai-review/core';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import type { ReviewCommandResult } from '../src/review/commands';
import { VsCodeWorkspaceTools } from '../src/review/workspace';

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

const CONFIG_TS = '/** Request timeout in seconds. */\nexport const REQUEST_TIMEOUT = 30;\n';
const CLIENT_V1 = [
  "import { REQUEST_TIMEOUT } from './config';",
  '',
  'export class Client {',
  '  private readonly base = "https://example.invalid";',
  '',
  '  call(controller: AbortController): void {',
  '    const started = Date.now();',
  '    void started;',
  '    setTimeout(() => controller.abort(), 1000);',
  '  }',
  '}',
  '',
].join('\n');
const CLIENT_V2 = CLIENT_V1.replace('1000);', 'REQUEST_TIMEOUT);');
const BUG_QUOTE = 'setTimeout(() => controller.abort(), REQUEST_TIMEOUT);';

/** Stub agent: reads src/config.ts first, then reports the units bug if it saw "seconds". */
function agent(req: ChatRequest): MockStep {
  if (!req.tools) return { events: [{ type: 'text', delta: '## Walkthrough\n- stub' }] };
  const parts = req.messages.flatMap((m) => m.content);
  const exploring = req.tools.some((t) => t.name === 'read_file');
  const results = parts.filter((p) => p.type === 'tool_result');
  if (exploring && !results.length) {
    return {
      events: [
        { type: 'tool_call', id: 'r1', name: 'read_file', input: { path: 'src/config.ts' } },
      ],
    };
  }
  const sawSeconds = JSON.stringify(results).includes('in seconds');
  const findings = sawSeconds
    ? [
        {
          file: 'src/client.ts',
          startLine: 9,
          endLine: 9,
          severity: 'major',
          category: 'bug',
          title: 'REQUEST_TIMEOUT is in seconds',
          body: 'setTimeout takes milliseconds; see src/config.ts.',
          quote: BUG_QUOTE,
          confidence: 0.9,
        },
      ]
    : [];
  return {
    events: [{ type: 'tool_call', id: 'f1', name: 'report_findings', input: { findings } }],
  };
}

suite('Context & agentic review', () => {
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
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'air-agent-')));
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    write('src/config.ts', CONFIG_TS);
    write('src/client.ts', CLIENT_V1);
    write('AGENTS.md', '- Never use the `any` type.\n');
    write('.env', 'API_TOKEN=do-not-send-this\n');
    write('big.txt', 'x'.repeat(5_000));
    git('add', 'src', 'AGENTS.md', 'big.txt');
    git('commit', '-q', '-m', 'init');
    write('src/client.ts', CLIENT_V2);
  });

  setup(() => {
    stub = new MockProvider({
      id: 'copilot',
      models: [
        {
          id: 'stub',
          name: 'Stub',
          vendor: 'copilot',
          maxInputTokens: 100_000,
          maxOutputTokens: 4_000,
          supportsTools: true,
        },
      ],
      fallback: agent,
    });
    disposables.push(
      api.registry.register('copilot', { label: 'Stub', provider: stub, isAvailable: () => true }),
    );
  });

  teardown(async () => {
    vscode.Disposable.from(...disposables.splice(0)).dispose();
    api.findings.clear();
    // Each test starts without earlier reviews or dismissed findings.
    await api.snapshots.clear();
    await api.statuses.clear();
    rmSync(path.join(root, '.codereview.yml'), { force: true });
    api.configs.forget(root);
    await vscode.workspace
      .getConfiguration('aiReview')
      .update('reviewMode', undefined, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // left in the temp dir
    }
  });

  test('workspace tools refuse paths outside the repo and secrets, and cap results (P4-3)', async () => {
    const ws = new VsCodeWorkspaceTools(root, noopLogger, { maxReadChars: 1_000 });
    const tools = new Map(createReviewTools(ws).map((t) => [t.def.name, t]));
    const run = (name: string, input: unknown) => {
      const tool = tools.get(name)! as unknown as AgentTool<unknown>;
      return tool.run(tool.schema.parse(input), new AbortController().signal);
    };
    await assert.rejects(() => run('read_file', { path: '../outside.ts' }), /outside/);
    await assert.rejects(
      () => run('read_file', { path: path.join(root, 'src', 'config.ts') }),
      /outside/,
    );
    await assert.rejects(() => run('read_file', { path: '.env' }), /secrets/);
    assert.strictEqual(await run('search_code', { pattern: 'do-not-send' }), 'No matches.');
    const big = await run('read_file', { path: 'big.txt' });
    assert.ok(big.includes('truncated at 1000 characters'), big.slice(-200));
    const refs = await run('find_references', {
      path: 'src/config.ts',
      line: 2,
      symbol: 'REQUEST_TIMEOUT',
    });
    assert.match(refs, /src\/client\.ts:\d+:/);
  });

  test('a changed method is sent with the whole method and the class header (P4-1)', async () => {
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewUnstaged',
      { root, silent: true },
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.result?.mode, 'single-pass');
    const sent = JSON.stringify(stub.requests[0]!.messages);
    assert.ok(sent.includes('<context path=\\"src/client.ts\\">'), sent.slice(0, 2000));
    assert.ok(sent.includes('export class Client {'));
    assert.ok(sent.includes('call(controller: AbortController): void {'));
    // Repo rules reach the model as a cached system block.
    const system = stub.requests[0]!.system;
    assert.ok(system.at(-1)!.cache);
    assert.ok(system.at(-1)!.text.includes('Never use the `any` type.'));
    assert.deepStrictEqual(result.result?.rules, ['AGENTS.md']);
  });

  test('agentic mode reads another file and finds the cross-file bug (P4-6)', async () => {
    write('.codereview.yml', 'review:\n  mode: agentic\n');
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewUnstaged',
      { root, silent: true },
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.result?.mode, 'agentic');
    assert.strictEqual(result.result?.agent?.toolCalls, 1);
    assert.strictEqual(result.findings?.length, 1);
    assert.strictEqual(result.findings![0]!.startLine, 9);
    assert.ok(!JSON.stringify(stub.requests).includes('do-not-send-this'));
  });

  test('aiReview.reviewMode overrides the repository mode', async () => {
    write('.codereview.yml', 'review:\n  mode: agentic\n');
    await vscode.workspace
      .getConfiguration('aiReview')
      .update('reviewMode', 'single-pass', vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<ReviewCommandResult>(
      'aiReview.reviewUnstaged',
      { root, silent: true },
    );
    assert.strictEqual(result.result?.mode, 'single-pass');
    assert.strictEqual(result.findings?.length, 0);
  });
});
