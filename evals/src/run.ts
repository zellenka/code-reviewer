/**
 * Eval runner: `pnpm eval --provider mock|anthropic [--model id] [--fixture name] [--json out.json] [--strict]`
 *
 * For each fixture: build a temp git repo (before → commit → after), take the unstaged
 * diff through node-host, run the real review pipeline, and score against the expected findings.
 * `mock` is an oracle that reports the expected findings (with wrong line numbers): it tests
 * the pipeline, not the model, and must score 100%. `anthropic` needs ANTHROPIC_API_KEY.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AnthropicProvider,
  DEFAULT_CONFIG,
  MockProvider,
  emptyUsage,
  addUsage,
  estimateCostUsd,
  runReview,
  type ChatRequest,
  type LLMProvider,
  type MockStep,
  type ModelInfo,
  type Usage,
} from '@ai-review/core';
import { GitCliDiffSource } from '@ai-review/node-host';
import { loadFixtures, type Fixture } from './fixtures';
import { scoreFixture, totals, type FixtureScore } from './score';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'eval',
  GIT_AUTHOR_EMAIL: 'eval@example.com',
  GIT_COMMITTER_NAME: 'eval',
  GIT_COMMITTER_EMAIL: 'eval@example.com',
};

/** MVP exit criteria from the implementation plan. */
const GATES = { precision: 0.7, cleanFindings: 0, nitsPer100Lines: 3, parseRate: 0.95 };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string' },
      fixture: { type: 'string' },
      json: { type: 'string' },
      strict: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
    },
  });
  const fixtures = await loadFixtures(undefined, values.fixture);
  if (!fixtures.length) {
    console.error('No fixtures matched.');
    return 1;
  }

  const scores: FixtureScore[] = [];
  let usage: Usage = emptyUsage();
  let model: ModelInfo | undefined;
  for (const fixture of fixtures) {
    const { provider, model: m } = await createProvider(values.provider!, values.model, fixture);
    model = m;
    const repo = makeRepo(fixture);
    try {
      const diff = await new GitCliDiffSource({ root: repo }).getDiff({ kind: 'unstaged' });
      const changedLines = diff.files.reduce(
        (n, f) =>
          n + f.hunks.reduce((h, k) => h + k.lines.filter((l) => l.kind === 'add').length, 0),
        0,
      );
      try {
        const result = await runReview(diff, {
          provider,
          model: m,
          config: DEFAULT_CONFIG,
          ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
        });
        usage = addUsage(usage, result.usage);
        scores.push(
          scoreFixture(fixture.id, fixture.expected, result.findings, {
            changedLines,
            outcomes: result.chunks.outcomes,
            ...(result.errors.length ? { error: result.errors.join('; ') } : {}),
          }),
        );
      } catch (err) {
        scores.push(
          scoreFixture(fixture.id, fixture.expected, [], {
            changedLines,
            outcomes: ['failed'],
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
    }
    printFixture(scores.at(-1)!);
  }

  const clean = new Set(fixtures.filter((f) => f.expected.length === 0).map((f) => f.id));
  const t = totals(scores, clean);
  const cost = model?.pricing ? estimateCostUsd(usage, model.pricing) : undefined;
  console.log('\n== Totals ==');
  console.log(`provider: ${values.provider}${model ? ` (${model.id})` : ''}`);
  console.log(`parse rate:  ${pct(t.parseRate)}   (gate ≥ ${pct(GATES.parseRate)})`);
  console.log(`precision:   ${pct(t.precision)}   (gate ≥ ${pct(GATES.precision)})`);
  console.log(`recall:      ${pct(t.recall)}`);
  console.log(`clean-fixture findings: ${t.cleanFindings}   (gate ${GATES.cleanFindings})`);
  console.log(
    `nits / 100 changed lines: ${t.nitsPer100Lines.toFixed(2)}   (gate ≤ ${GATES.nitsPer100Lines})`,
  );
  console.log(
    `usage: ${usage.inputTokens} in / ${usage.outputTokens} out, ${usage.requests} request(s)${cost !== undefined ? `, ≈ $${cost.toFixed(4)}` : ''}`,
  );
  if (t.errors) console.log(`fixtures with errors: ${t.errors}`);

  if (values.json) {
    await writeFile(
      values.json,
      JSON.stringify(
        { provider: values.provider, model: model?.id, totals: t, usage, scores },
        null,
        2,
      ),
    );
    console.log(`report written to ${values.json}`);
  }

  const passedGates =
    t.parseRate >= GATES.parseRate &&
    t.precision >= GATES.precision &&
    t.cleanFindings <= GATES.cleanFindings &&
    t.nitsPer100Lines <= GATES.nitsPer100Lines;
  if (values.provider === 'mock') {
    // The oracle must be perfect; anything less is a pipeline bug.
    const perfect = t.parseRate === 1 && t.precision === 1 && t.recall === 1 && t.errors === 0;
    console.log(perfect ? '\nmock run: pipeline OK' : '\nmock run: pipeline FAILED');
    return perfect ? 0 : 1;
  }
  console.log(passedGates ? '\nMVP gates: passed' : '\nMVP gates: NOT passed');
  return values.strict && !passedGates ? 1 : 0;
}

async function createProvider(
  name: string,
  modelId: string | undefined,
  fixture: Fixture,
): Promise<{ provider: LLMProvider; model: ModelInfo }> {
  if (name === 'mock') {
    const provider = new MockProvider({ fallback: (req) => oracle(req, fixture) });
    return { provider, model: (await provider.listModels())[0]! };
  }
  if (name === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to run evals against Anthropic.');
    const provider = new AnthropicProvider({ apiKey });
    const models = await provider.listModels();
    const id = modelId ?? process.env.ANTHROPIC_EVAL_MODEL ?? 'claude-sonnet-5-5';
    const model = models.find((m) => m.id === id);
    if (!model)
      throw new Error(
        `Unknown Anthropic model ${id}. Known: ${models.map((m) => m.id).join(', ')}`,
      );
    return { provider, model };
  }
  throw new Error(`Unknown provider "${name}". Use mock or anthropic.`);
}

/** Reports every expected finding whose quote is in the request, 3 lines off. */
function oracle(req: ChatRequest, fixture: Fixture): MockStep {
  const sent = req.messages
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
  const findings = fixture.expected
    .filter((e) => sent.includes(e.quote.split('\n')[0]!.trim()))
    .map((e) => {
      const [start, end] = typeof e.lines === 'number' ? [e.lines, e.lines] : e.lines;
      return {
        file: e.file,
        startLine: start + 3,
        endLine: end + 3,
        severity: e.severity,
        category: e.category,
        title: e.title,
        body: e.title,
        quote: e.quote,
        confidence: 0.9,
      };
    });
  return {
    events: [{ type: 'tool_call', id: 'oracle', name: 'report_findings', input: { findings } }],
  };
}

function makeRepo(fixture: Fixture): string {
  const root = mkdtempSync(path.join(tmpdir(), `air-eval-${fixture.id}-`));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: GIT_ENV, stdio: 'pipe' });
  const write = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  write(fixture.before);
  git('add', '-A');
  git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'before');
  write(fixture.after);
  return root;
}

function printFixture(s: FixtureScore): void {
  const status = s.error
    ? 'ERROR'
    : s.expected === 0
      ? s.reported
        ? 'FP'
        : 'clean'
      : `${s.hits}/${s.expected}`;
  console.log(
    `${s.id.padEnd(28)} ${status.padEnd(6)} reported ${s.reported}, false positives ${s.falsePositives.length}, parse ${s.outcomes.join(',')}`,
  );
  for (const m of s.misses) console.log(`    miss: ${m.file}:${m.lines} ${m.title}`);
  for (const f of s.falsePositives)
    console.log(`    extra: ${f.file}:${f.startLine} [${f.severity}/${f.category}] ${f.title}`);
  if (s.error) console.log(`    error: ${s.error}`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
