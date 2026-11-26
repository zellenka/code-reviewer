import { SEVERITIES, severityRank } from '../config/schema';
import { neutralizeMarkdown } from './markdown';
import type { Finding, ReviewResult } from './types';

/** A finding in a report; only open ones are listed, the others are counted. */
export interface ReportFinding extends Finding {
  status?: 'open' | 'resolved' | 'dismissed';
}

export interface ReviewReport {
  /** What was reviewed (`describeMode`). */
  scope: string;
  /** Model name. */
  model: string;
  finishedAt?: Date;
  result: ReviewResult;
  findings: readonly ReportFinding[];
  /** Estimated cost in USD, when the model's prices are known. */
  costUsd?: number;
}

export interface ReportOptions {
  /** How a file is named (default: its repo-relative path). */
  filePath?: (file: string) => string;
  /** Leave out the "Details" section (files, tokens, cost, warnings). Default false. */
  omitDetails?: boolean;
  /** List at most this many open findings, the most severe; the rest are counted. */
  maxFindings?: number;
}

/**
 * The review as a Markdown document: summary, open findings by file (worst first) with
 * their code and suggested fix, and the review details. Model-written text is neutralized
 * (no images or HTML), and code is quoted as the model saw it: secrets stay redacted.
 */
export function reviewToMarkdown(report: ReviewReport, options: ReportOptions = {}): string {
  const { result } = report;
  const open = report.findings.filter((f) => (f.status ?? 'open') === 'open');
  const out: string[] = [`# AI Review: ${oneLine(report.scope)}`];
  const meta = [
    oneLine(report.model),
    report.finishedAt ? formatDate(report.finishedAt) : undefined,
    countFindings(open),
  ].filter(Boolean);
  out.push(`_${meta.join(' · ')}_`);
  if (result.cancelled) out.push('> Cancelled: findings from the parts that finished.');

  if (result.summary) out.push('## Summary', neutralizeMarkdown(result.summary.trim()));

  out.push('## Findings');
  if (!open.length) out.push('No open findings.');
  const listed = mostSevere(open, options.maxFindings ?? Infinity);
  let n = 0;
  for (const [file, list] of byFile(listed)) {
    out.push(`### ${inlineCode(options.filePath?.(file) ?? file)}`);
    for (const f of list) out.push(findingMarkdown(f, { heading: `#### ${++n}.` }));
  }
  if (listed.length < open.length) {
    out.push(`_${open.length - listed.length} less severe finding(s) not listed._`);
  }

  if (!options.omitDetails) out.push('## Details', details(report));
  return `${out.join('\n\n')}\n`;
}

/**
 * One finding as Markdown: title (after `heading`, e.g. `####`), severity, category, lines,
 * the model's explanation, the quoted code and the suggested fix.
 */
export function findingMarkdown(
  f: Finding,
  options: { heading?: string; file?: string } = {},
): string {
  const out: string[] = [`${options.heading ?? '####'} ${oneLine(neutralizeMarkdown(f.title))}`];
  const where = f.anchor === 'file' ? 'whole file' : lineRange(f.startLine, f.endLine);
  const facts = [
    `**${f.severity}**`,
    f.category,
    options.file ? `${inlineCode(options.file)} ${where}` : where,
    `confidence ${f.confidence.toFixed(2)}`,
    f.stale ? 'outdated: the code has changed since the review' : undefined,
  ].filter(Boolean);
  out.push(facts.join(' · '));
  if (f.body.trim()) out.push(neutralizeMarkdown(f.body.trim()));
  const quote = f.redactedQuote ?? f.quote;
  const lang = language(f.file);
  if (f.anchor === 'line' && quote.trim()) out.push(codeBlock(quote, lang));
  if (f.suggestion !== undefined) out.push('Suggested fix:', codeBlock(f.suggestion, lang));
  return out.join('\n\n');
}

/**
 * A prompt for an agent chat (Copilot, Claude Code) to work through the review's open
 * findings: check each one and fix the real ones. Same text as `reviewToMarkdown`, without
 * the details; `maxFindings` (default 50) keeps it a reasonable size.
 */
export function reviewChatPrompt(report: ReviewReport, options: ReportOptions = {}): string {
  const open = report.findings.some((f) => (f.status ?? 'open') === 'open');
  return [
    `Below is an AI code review of ${oneLine(report.scope)}. ${
      open
        ? 'Go through its open findings one by one: check whether each is a real problem in the code as it is now, fix the ones that are with the smallest change, and tell me which ones you skipped and why.'
        : 'It has no open findings; keep it in mind for what I ask next.'
    }`,
    reviewToMarkdown(report, { maxFindings: 50, ...options, omitDetails: true }),
  ].join('\n\n');
}

/** A prompt for an agent chat to check one finding and fix it if it's real. */
export function findingChatPrompt(f: Finding, options: { file?: string } = {}): string {
  const file = options.file ?? f.file;
  return [
    `Below is a finding from an AI code review of ${inlineCode(file)}. Check whether it's a real problem in the code as it is now. If it is, fix it with the smallest change; if not, tell me why.`,
    findingMarkdown(f, { heading: '###', file }),
  ].join('\n\n');
}

function details(report: ReviewReport): string {
  const { result } = report;
  const lines: string[] = [];
  const files = result.reviewedFiles;
  lines.push(
    `- Files reviewed: ${files.length}${files.length ? ` (${files.map(inlineCode).join(', ')})` : ''}`,
  );
  if (result.skipped.length) {
    lines.push(
      `- Not reviewed: ${result.skipped.map((s) => `${inlineCode(s.path)} (${s.reason})`).join(', ')}`,
    );
  }
  const resolved = report.findings.filter((f) => f.status === 'resolved').length;
  const dismissed = report.findings.filter((f) => f.status === 'dismissed').length;
  if (resolved || dismissed) {
    lines.push(`- Not listed: ${resolved} resolved, ${dismissed} dismissed`);
  }
  const u = result.usage;
  const input = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  lines.push(
    `- Tokens: ${input} in, ${u.outputTokens} out, ${u.requests} request(s)${u.estimated ? ' (estimated)' : ''}`,
  );
  if (report.costUsd !== undefined) lines.push(`- Cost: about $${report.costUsd.toFixed(4)}`);
  lines.push(`- Mode: ${result.mode}`);
  if (result.rules?.length) lines.push(`- Rules: ${result.rules.map(inlineCode).join(', ')}`);
  for (const w of [...(result.warnings ?? []), ...result.errors]) {
    lines.push(`- Warning: ${oneLine(neutralizeMarkdown(w))}`);
  }
  return lines.join('\n');
}

/** `2 findings (1 major, 1 minor)`. */
function countFindings(findings: readonly Finding[]): string {
  if (!findings.length) return 'no open findings';
  const counts = SEVERITIES.map(
    (s) => [s, findings.filter((f) => f.severity === s).length] as const,
  )
    .filter(([, c]) => c > 0)
    .map(([s, c]) => `${c} ${s}`);
  return `${findings.length} open finding(s) (${counts.join(', ')})`;
}

/** The `max` most severe findings (the most confident first among equals), in their order. */
function mostSevere<T extends Finding>(findings: readonly T[], max: number): T[] {
  if (findings.length <= max) return [...findings];
  const kept = new Set(
    [...findings]
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence,
      )
      .slice(0, max),
  );
  return findings.filter((f) => kept.has(f));
}

/** Findings grouped by file: the file with the worst finding first, lines in order. */
function byFile<T extends Finding>(findings: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const f of findings) groups.set(f.file, [...(groups.get(f.file) ?? []), f]);
  const worst = (list: T[]) => Math.max(...list.map((f) => severityRank(f.severity)));
  return [...groups]
    .sort(([a, la], [b, lb]) => worst(lb) - worst(la) || a.localeCompare(b))
    .map(([file, list]) => [file, list.sort((a, b) => a.startLine - b.startLine)]);
}

function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

/** Fenced code; the fence is longer than any backtick run in the code. */
function codeBlock(code: string, lang: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}`;
}

/** Inline code that holds any text (file names come from the repository). */
function inlineCode(text: string): string {
  const clean = oneLine(text);
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${clean}${pad}${ticks}`;
}

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** The fence's language: the file extension, when it's a plain word. */
function language(file: string): string {
  return /\.([A-Za-z0-9]{1,10})$/.exec(file)?.[1]?.toLowerCase() ?? '';
}

/** `2026-11-26 18:05` in local time. */
function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
