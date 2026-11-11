import { readFile } from 'node:fs/promises';
import type { FixtureScore, Totals } from './score';

/** One mode's results as saved in a JSON report. */
export interface ReportRun {
  mode: string;
  verify?: boolean;
  scores: FixtureScore[];
  totals: Totals;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    requests: number;
  };
  costUsd?: number;
}

export interface Report {
  provider?: string;
  model?: string;
  createdAt?: string;
  runs: ReportRun[];
}

/** P5-2 acceptance: the verify pass may cost at most this much recall (relative). */
export const MAX_RECALL_LOSS = 0.1;

export async function loadReport(file: string): Promise<Report> {
  const data = JSON.parse(await readFile(file, 'utf8')) as Report & Partial<ReportRun>;
  // Older single-mode reports had the run's fields at the top level.
  if (!Array.isArray(data.runs) && data.totals && data.scores) {
    return { ...data, runs: [data as ReportRun] };
  }
  if (!Array.isArray(data.runs)) throw new Error(`${file}: not an eval report`);
  return data;
}

export function runLabel(report: Report, run: ReportRun): string {
  return `${report.model ?? report.provider ?? '?'} ${run.mode}${run.verify ? '+verify' : ''}`;
}

/**
 * Compares two reports run by run (matched by mode, else by position): totals with
 * deltas, fixtures whose hits or false positives changed, and the precision/recall
 * trade-off. Returns printable lines.
 */
export function compareReports(base: Report, next: Report): string[] {
  const out: string[] = [];
  next.runs.forEach((b, i) => {
    const a = base.runs.find((r) => r.mode === b.mode) ?? base.runs[i];
    if (!a) return;
    out.push('', `== ${runLabel(base, a)}  →  ${runLabel(next, b)} ==`);
    const row = (label: string, x: number, y: number, fmt: (n: number) => string, delta: string) =>
      out.push(
        `${label.padEnd(22)} ${fmt(x).padStart(10)} ${fmt(y).padStart(10)} ${delta.padStart(10)}`,
      );
    const pctRow = (label: string, x: number, y: number) =>
      row(label, x, y, pct, `${y - x >= 0 ? '+' : ''}${((y - x) * 100).toFixed(1)}pp`);
    const numRow = (label: string, x: number, y: number) =>
      row(
        label,
        x,
        y,
        (n) => String(Math.round(n * 100) / 100),
        `${y - x >= 0 ? '+' : ''}${Math.round((y - x) * 100) / 100}`,
      );
    pctRow('precision', a.totals.precision, b.totals.precision);
    pctRow('recall', a.totals.recall, b.totals.recall);
    pctRow('cross-file recall', a.totals.crossFileRecall, b.totals.crossFileRecall);
    pctRow('parse rate', a.totals.parseRate, b.totals.parseRate);
    numRow('clean findings', a.totals.cleanFindings, b.totals.cleanFindings);
    numRow('nits / 100 lines', a.totals.nitsPer100Lines, b.totals.nitsPer100Lines);
    numRow('requests', a.usage.requests, b.usage.requests);
    numRow('input tokens', totalInput(a), totalInput(b));
    numRow('output tokens', a.usage.outputTokens, b.usage.outputTokens);
    if (a.costUsd !== undefined && b.costUsd !== undefined)
      numRow('cost ($)', a.costUsd, b.costUsd);

    const byId = new Map(a.scores.map((s) => [s.id, s]));
    for (const s of b.scores) {
      const old = byId.get(s.id);
      if (!old) {
        out.push(
          `  new fixture ${s.id}: ${s.hits}/${s.expected} hits, ${s.falsePositives.length} false positive(s)`,
        );
        continue;
      }
      const changes: string[] = [];
      if (s.hits !== old.hits) changes.push(`hits ${old.hits} → ${s.hits}/${s.expected}`);
      if (s.falsePositives.length !== old.falsePositives.length)
        changes.push(`false positives ${old.falsePositives.length} → ${s.falsePositives.length}`);
      if (changes.length) out.push(`  ${s.id}: ${changes.join(', ')}`);
    }

    const recallLoss = a.totals.recall ? 1 - b.totals.recall / a.totals.recall : 0;
    const precisionGain = b.totals.precision - a.totals.precision;
    out.push(
      `verdict: precision ${precisionGain >= 0 ? '+' : ''}${(precisionGain * 100).toFixed(1)}pp, recall ${recallLoss > 0 ? `-${pct(recallLoss)} (relative)` : 'not lower'} → ${
        precisionGain > 0 && recallLoss <= MAX_RECALL_LOSS
          ? 'better'
          : precisionGain <= 0 && recallLoss <= 0
            ? 'no gain'
            : recallLoss > MAX_RECALL_LOSS
              ? `recall loss above ${pct(MAX_RECALL_LOSS)}`
              : 'no precision gain'
      }`,
    );
  });
  return out;
}

function totalInput(r: ReportRun): number {
  return r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** CLI: pnpm eval:compare base.json new.json */
if (require.main === module) {
  const [baseFile, nextFile] = process.argv.slice(2);
  if (!baseFile || !nextFile) {
    console.error('Usage: pnpm eval:compare <base-report.json> <new-report.json>');
    process.exit(1);
  }
  Promise.all([loadReport(baseFile), loadReport(nextFile)]).then(
    ([a, b]) => {
      console.log(compareReports(a, b).join('\n'));
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
