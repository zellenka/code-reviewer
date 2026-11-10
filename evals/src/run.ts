/**
 * Eval runner:
 *   pnpm eval --provider mock|anthropic [--model id] [--mode single-pass|agentic|compare]
 *             [--fixture name] [--json out.json] [--baseline old.json] [--strict] [--no-summary]
 *             [--verify] [--verify-model id]
 *
 * For each fixture: build a temp git repo (before → commit → after), take the unstaged
 * diff through node-host, load the repo rules, run the real review pipeline, and score
 * against the expected findings. `mock` is an oracle that reports the expected findings
 * (with wrong line numbers; in agentic mode after one real tool call): it tests the
 * pipeline, not the model, and must score 100%. `anthropic` needs ANTHROPIC_API_KEY.
 * `--mode compare` runs single-pass and agentic on the same fixtures and prints both.
 * `--verify` turns on the verify pass (P5-2). `--baseline` compares with an earlier JSON
 * report (also: `pnpm eval:compare a.json b.json`).
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
  estimateReview,
  runReview,
  type ChatRequest,
  type LLMProvider,
  type MockStep,
  type ModelInfo,
  type ReviewConfig,
  type Usage,
  VERIFY_TOOL_NAME,
} from '@ai-review/core';
import { FsWorkspaceTools, GitCliDiffSource, loadRepoRulesFromDisk } from '@ai-review/node-host';
import { compareReports, loadReport, type Report } from './compare';
import { expectedCategories, loadFixtures, type Fixture } from './fixtures';
import { estimateError, scoreFixture, totals, type FixtureScore, type Totals } from './score';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'eval',
  GIT_AUTHOR_EMAIL: 'eval@example.com',
  GIT_COMMITTER_NAME: 'eval',
  GIT_COMMITTER_EMAIL: 'eval@example.com',
};

/** MVP exit criteria from the implementation plan. */
const GATES = {
  precision: 0.7,
  cleanFindings: 0,
  nitsPer100Lines: 3,
  parseRate: 0.95,
  /** P3-4: pre-run input-token estimate within ±30% of actual (reported, not gated). */
  estimateError: 0.3,
};

type Mode = 'single-pass' | 'agentic';

interface ModeRun {
  mode: Mode;
  verify: boolean;
  scores: FixtureScore[];
  totals: Totals;
  usage: Usage;
  costUsd?: number;
  /** Agentic only: tool calls over all fixtures. */
  toolCalls: number;
  /** Verify pass: findings checked and rejected over all fixtures. */
  verified?: { checked: number; rejected: number; failed: number };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string' },
      mode: { type: 'string', default: 'single-pass' },
      fixture: { type: 'string' },
      json: { type: 'string' },
      baseline: { type: 'string' },
      verify: { type: 'boolean', default: false },
      'verify-model': { type: 'string' },
      strict: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      'no-summary': { type: 'boolean', default: false },
    },
  });
  const modes: Mode[] =
    values.mode === 'compare'
      ? ['single-pass', 'agentic']
      : values.mode === 'agentic' || values.mode === 'single-pass'
        ? [values.mode]
        : [];
  if (!modes.length) {
    console.error(`Unknown --mode "${values.mode}". Use single-pass, agentic or compare.`);
    return 1;
  }
  const summary = !values['no-summary'];
  const fixtures = await loadFixtures(undefined, values.fixture);
  if (!fixtures.length) {
    console.error('No fixtures matched.');
    return 1;
  }
  const clean = new Set(fixtures.filter((f) => f.expected.length === 0).map((f) => f.id));
  const verify = values.verify || !!values['verify-model'];

  const runs: ModeRun[] = [];
  let model: ModelInfo | undefined;
  for (const mode of modes) {
    console.log(`\n== ${mode} ==`);
    const config: ReviewConfig = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, mode, verify },
    };
    const scores: FixtureScore[] = [];
    let usage: Usage = emptyUsage();
    let toolCalls = 0;
    const verified = { checked: 0, rejected: 0, failed: 0 };
    for (const fixture of fixtures) {
      const { provider, model: m } = await createProvider(values.provider!, values.model, fixture);
      model = m;
      const verifyModel = values['verify-model']
        ? (await provider.listModels()).find((x) => x.id === values['verify-model'])
        : undefined;
      if (values['verify-model'] && !verifyModel) {
        throw new Error(`Unknown verify model ${values['verify-model']}`);
      }
      const repo = makeRepo(fixture);
      try {
        const diff = await new GitCliDiffSource({ root: repo }).getDiff({ kind: 'unstaged' });
        const changedLines = diff.files.reduce(
          (n, f) =>
            n + f.hunks.reduce((h, k) => h + k.lines.filter((l) => l.kind === 'add').length, 0),
          0,
        );
        try {
          const rules = await loadRepoRulesFromDisk(repo, config);
          const workspace = new FsWorkspaceTools(repo);
          const estimate = estimateReview(diff, { model: m, config, summary, rules, workspace });
          const result = await runReview(diff, {
            provider,
            model: m,
            config,
            summary,
            rules,
            workspace,
            ...(verifyModel ? { verifyModel } : {}),
            ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
          });
          usage = addUsage(usage, result.usage);
          toolCalls += result.agent?.toolCalls ?? 0;
          if (result.verify) {
            verified.checked += result.verify.checked;
            verified.rejected += result.verify.rejected;
            verified.failed += result.verify.failed;
          }
          scores.push({
            ...scoreFixture(fixture.id, fixture.expected, result.findings, {
              changedLines,
              outcomes: result.chunks.outcomes,
              ...(result.errors.length ? { error: result.errors.join('; ') } : {}),
            }),
            summary: !!result.summary,
            inputTokens: {
              estimated: estimate.inputTokens,
              actual:
                result.usage.inputTokens +
                (result.usage.cacheReadTokens ?? 0) +
                (result.usage.cacheWriteTokens ?? 0),
            },
            ...(result.agent ? { toolCalls: result.agent.toolCalls } : {}),
          });
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
      printFixture(scores.at(-1)!, mode);
    }
    const run: ModeRun = { mode, verify, scores, totals: totals(scores, clean), usage, toolCalls };
    if (verify) run.verified = verified;
    if (model?.pricing) run.costUsd = estimateCostUsd(usage, model.pricing);
    printTotals(run, values.provider!, model, summary);
    runs.push(run);
  }
  if (runs.length === 2) printComparison(runs[0]!, runs[1]!);

  const report: Report = {
    provider: values.provider!,
    ...(model ? { model: model.id } : {}),
    createdAt: new Date().toISOString(),
    runs,
  };
  if (values.json) {
    await writeFile(values.json, JSON.stringify(report, null, 2));
    console.log(`report written to ${values.json}`);
  }
  if (values.baseline) {
    console.log(`\n== compared with ${values.baseline} ==`);
    console.log(compareReports(await loadReport(values.baseline), report).join('\n'));
  }

  if (values.provider === 'mock') {
    // The oracle must be perfect; anything less is a pipeline bug.
    const perfect = runs.every(
      ({ totals: t, scores, mode, toolCalls }) =>
        t.parseRate === 1 &&
        t.precision === 1 &&
        t.recall === 1 &&
        t.errors === 0 &&
        (!summary || scores.every((s) => s.summary)) &&
        (mode !== 'agentic' || toolCalls > 0) &&
        (!verify || (runs.every((r) => (r.verified?.checked ?? 0) > 0) && t.recall === 1)),
    );
    console.log(perfect ? '\nmock run: pipeline OK' : '\nmock run: pipeline FAILED');
    return perfect ? 0 : 1;
  }
  const passed = runs.every(({ totals: t }) => passesGates(t));
  console.log(passed ? '\nMVP gates: passed' : '\nMVP gates: NOT passed');
  return values.strict && !passed ? 1 : 0;
}

function passesGates(t: Totals): boolean {
  return (
    t.parseRate >= GATES.parseRate &&
    t.precision >= GATES.precision &&
    t.cleanFindings <= GATES.cleanFindings &&
    t.nitsPer100Lines <= GATES.nitsPer100Lines
  );
}

function printTotals(
  run: ModeRun,
  provider: string,
  model: ModelInfo | undefined,
  summary: boolean,
) {
  const { totals: t, usage, scores } = run;
  console.log(`\n-- totals (${run.mode}) --`);
  console.log(`provider: ${provider}${model ? ` (${model.id})` : ''}`);
  console.log(`parse rate:  ${pct(t.parseRate)}   (gate ≥ ${pct(GATES.parseRate)})`);
  console.log(`precision:   ${pct(t.precision)}   (gate ≥ ${pct(GATES.precision)})`);
  console.log(`recall:      ${pct(t.recall)}   (cross-file: ${pct(t.crossFileRecall)})`);
  console.log(`clean-fixture findings: ${t.cleanFindings}   (gate ${GATES.cleanFindings})`);
  console.log(
    `nits / 100 changed lines: ${t.nitsPer100Lines.toFixed(2)}   (gate ≤ ${GATES.nitsPer100Lines})`,
  );
  console.log(
    `usage: ${usage.inputTokens} in (+${usage.cacheReadTokens ?? 0} cache read, +${usage.cacheWriteTokens ?? 0} cache write) / ${usage.outputTokens} out, ${usage.requests} request(s)${run.costUsd !== undefined ? `, ≈ $${run.costUsd.toFixed(4)}` : ''}`,
  );
  if (run.mode === 'agentic') console.log(`tool calls:  ${run.toolCalls}`);
  if (run.verified) {
    console.log(
      `verify pass: ${run.verified.rejected} of ${run.verified.checked} finding(s) rejected${run.verified.failed ? `, ${run.verified.failed} request(s) failed` : ''}`,
    );
  }
  if (t.errors) console.log(`fixtures with errors: ${t.errors}`);
  const withSummary = scores.filter((s) => s.summary).length;
  if (summary) console.log(`summaries:   ${withSummary}/${scores.length}`);
  if (run.mode === 'single-pass') {
    const estimates = scores.flatMap((s) => (s.inputTokens ? [estimateError(s.inputTokens)] : []));
    const worst = estimates.length ? Math.max(...estimates.map(Math.abs)) : 0;
    console.log(
      `input-token estimate: worst error ${pct(worst)}   (target ≤ ${pct(GATES.estimateError)})`,
    );
  }
}

/** P4-6: side-by-side numbers and the fixtures only one mode got right. */
function printComparison(a: ModeRun, b: ModeRun): void {
  const row = (label: string, f: (r: ModeRun) => string) =>
    console.log(`${label.padEnd(20)} ${f(a).padStart(14)} ${f(b).padStart(14)}`);
  console.log('\n== comparison ==');
  row('', (r) => r.mode);
  row('precision', (r) => pct(r.totals.precision));
  row('recall', (r) => pct(r.totals.recall));
  row('cross-file recall', (r) => pct(r.totals.crossFileRecall));
  row('clean findings', (r) => String(r.totals.cleanFindings));
  row('requests', (r) => String(r.usage.requests));
  row('input tokens', (r) =>
    String(r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0)),
  );
  row('output tokens', (r) => String(r.usage.outputTokens));
  row('cost', (r) => (r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : '-'));
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    const only = x.scores.filter((s, i) => s.hits > (y.scores[i]?.hits ?? 0)).map((s) => s.id);
    if (only.length) console.log(`found more with ${x.mode}: ${only.join(', ')}`);
  }
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

/**
 * Reports every expected finding whose quote is in the request, 3 lines off.
 * With agent tools available, it first reads one file (once) to exercise the loop.
 */
function oracle(req: ChatRequest, fixture: Fixture): MockStep {
  if (req.tools?.some((t) => t.name === VERIFY_TOOL_NAME)) {
    // Verify pass: every finding the oracle reported is real.
    const text = req.messages
      .flatMap((m) => m.content)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n');
    const ids = [...text.matchAll(/<finding id="(F\d+)"/g)].map((m) => m[1]);
    return {
      events: [
        {
          type: 'tool_call',
          id: 'oracle_verify',
          name: VERIFY_TOOL_NAME,
          input: { verdicts: ids.map((id) => ({ id, real: true, reason: 'oracle' })) },
        },
      ],
    };
  }
  if (!req.tools) {
    // The summary request (no tools): any non-empty markdown will do.
    return {
      events: [
        { type: 'text', delta: `## Walkthrough\n- ${fixture.id}\n\n## Top risks\n- see findings` },
      ],
    };
  }
  const parts = req.messages.flatMap((m) => m.content);
  const exploring = req.tools.some((t) => t.name === 'read_file');
  if (exploring && !parts.some((p) => p.type === 'tool_result')) {
    const target = fixture.expected[0]?.file ?? Object.keys(fixture.after)[0]!;
    return {
      events: [
        { type: 'tool_call', id: 'oracle_read', name: 'read_file', input: { path: target } },
      ],
    };
  }
  const sent = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const findings = fixture.expected
    .filter((e) => sent.includes(e.quote.split('\n')[0]!.trim()))
    .map((e) => {
      const [start, end] = typeof e.lines === 'number' ? [e.lines, e.lines] : e.lines;
      return {
        file: e.file,
        startLine: start + 3,
        endLine: end + 3,
        severity: e.severity,
        category: expectedCategories(e)[0],
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
      writeFileSync(
        path.join(root, rel),
        fixture.eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : content,
      );
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

function printFixture(s: FixtureScore, mode: Mode): void {
  const status = s.error
    ? 'ERROR'
    : s.expected === 0
      ? s.reported
        ? 'FP'
        : 'clean'
      : `${s.hits}/${s.expected}`;
  const tools =
    mode === 'agentic' && s.toolCalls !== undefined ? `, ${s.toolCalls} tool call(s)` : '';
  console.log(
    `${s.id.padEnd(28)} ${status.padEnd(6)} reported ${s.reported}, false positives ${s.falsePositives.length}, parse ${s.outcomes.join(',')}${tools}`,
  );
  if (s.inputTokens) {
    console.log(
      `    input tokens: estimated ${s.inputTokens.estimated}, actual ${s.inputTokens.actual} (${signedPct(estimateError(s.inputTokens))})${s.summary === false ? ', no summary' : ''}`,
    );
  }
  for (const m of s.misses) console.log(`    miss: ${m.file}:${m.lines} ${m.title}`);
  for (const f of s.falsePositives)
    console.log(`    extra: ${f.file}:${f.startLine} [${f.severity}/${f.category}] ${f.title}`);
  if (s.error) console.log(`    error: ${s.error}`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function signedPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${pct(n)}`;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
