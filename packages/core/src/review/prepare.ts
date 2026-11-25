import { DEFAULT_AGENT_LIMITS, type AgentLimits } from '../agent/loop';
import { reviewToolDefs } from '../agent/tools';
import type { ReviewConfig } from '../config/schema';
import type { FileDiff, Hunk, UnifiedDiff } from '../diff/types';
import type { ModelInfo, ToolDef } from '../provider/types';
import { estimateTokens } from '../provider/usage';
import { chunkFiles, type Chunk } from './chunker';
import { buildFileContext, changedSymbols, renderChangedSymbols } from './context';
import { filterFiles, type RelaxedIgnore } from './filter';
import {
  planIncremental,
  snapshotKey,
  type IncrementalPlan,
  type ReviewSnapshot,
} from './incremental';
import type { ReviewOptions } from './orchestrator';
import { REPORT_FINDINGS_TOOL } from './output';
import { buildSystemBlocks, buildUserPrompt } from './prompt';
import { redactFiles } from './redact';
import { renderRules } from './rules';
import type { SkippedFile } from './types';
import { buildVerifySystemPrompt } from './verify';

export type PrepareOptions = Pick<
  ReviewOptions,
  | 'model'
  | 'config'
  | 'redactHighEntropy'
  | 'maxChunkTokens'
  | 'maxChunks'
  | 'maxOutputTokens'
  | 'context'
  | 'symbols'
  | 'rules'
  | 'agentLimits'
  | 'leftOut'
> & {
  /** Whether repo access is available (`ReviewOptions.workspace`). */
  workspace?: unknown;
};

/** What `prepareDiff` reads besides `PrepareOptions`. */
export type PrepareDiffOptions = Omit<PrepareOptions, 'symbols'> & {
  previous?: ReviewSnapshot;
  verify?: boolean;
};

/**
 * A diff ready for review: filtered, redacted and planned against the previous review,
 * once per run. A host can make it first (`prepareDiff`), load symbols for `files`, and
 * pass it to `estimateReview` and `runReview` with the same options.
 */
export interface PreparedDiff {
  /** The diff as given. */
  diff: UnifiedDiff;
  /** Snapshot key of this review (`ReviewSnapshot.key`). */
  key: string;
  /** The `previous` it was planned against. */
  previous?: ReviewSnapshot;
  /** Files to review (the whole diff, filtered) as in the diff: to restore quotes. */
  files: FileDiff[];
  /** `files` redacted, as sent to the model (for the summary and the snapshot). */
  redacted: FileDiff[];
  skipped: SkippedFile[];
  /** Files the repository's `ignore:` may only skip when the user allows it (`filterFiles`). */
  relaxedIgnore: RelaxedIgnore[];
  /** When `previous` was made with the same key: what's new, what's carried over. */
  plan?: IncrementalPlan;
  /** What gets sent now: all of `files`, or with a plan only the new hunks. */
  review: { files: FileDiff[]; redacted: FileDiff[]; redactions: number };
}

/** Agentic needs repo access and a model that can call tools; else single-pass. */
export function resolveMode(
  options: Pick<PrepareOptions, 'config' | 'model' | 'workspace'>,
): 'single-pass' | 'agentic' {
  return options.config.review.mode === 'agentic' &&
    options.workspace &&
    options.model.supportsTools
    ? 'agentic'
    : 'single-pass';
}

/** System blocks of every review request: the prompt for `mode`, then the repo rules. */
function reviewSystem(
  options: PrepareDiffOptions,
  mode: 'single-pass' | 'agentic',
): { text: string; cache?: boolean }[] {
  const agentLimits = { ...DEFAULT_AGENT_LIMITS, ...options.agentLimits };
  const rules = renderRules(options.rules);
  return buildSystemBlocks({
    config: options.config,
    jsonOnly: !options.model.supportsTools,
    ...(mode === 'agentic'
      ? { agent: { maxTurns: agentLimits.maxTurns, maxToolCalls: agentLimits.maxToolCalls } }
      : {}),
    ...(rules ? { rules } : {}),
  });
}

/** The snapshot key of a review with these options. */
function reviewKey(options: PrepareDiffOptions): string {
  const mode = resolveMode(options);
  return snapshotKey({
    modelId: options.model.id,
    config: options.config,
    mode,
    context: options.context ?? true,
    ...(options.rules ? { rules: options.rules } : {}),
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
    redactHighEntropy: options.redactHighEntropy ?? false,
    prompts: [
      ...reviewSystem(options, mode).map((s) => s.text),
      buildVerifySystemPrompt(options.config),
    ],
  });
}

/**
 * Filter → redact → plan: the diff ready for review, and with `previous` (when made with
 * the same key) the incremental plan.
 */
export function prepareDiff(diff: UnifiedDiff, options: PrepareDiffOptions): PreparedDiff {
  const key = reviewKey(options);
  const filtered = filterFiles(diff.files, options.config);
  const { files, relaxedIgnore } = filtered;
  const skipped = [...filtered.skipped, ...(options.leftOut ?? [])];
  const redacted = redactFiles(files, { highEntropy: options.redactHighEntropy ?? false });
  const prepared: PreparedDiff = {
    diff,
    key,
    files,
    redacted: redacted.files,
    skipped,
    relaxedIgnore,
    review: { files, redacted: redacted.files, redactions: redacted.count },
  };
  if (!options.previous) return prepared;
  prepared.previous = options.previous;
  // Made with other settings: everything is reviewed again.
  if (options.previous.key !== key) return prepared;
  // Ignored files are never reviewed, so they are never "new" either.
  const plan = planIncremental({ files }, options.previous, { redacted: redacted.files });
  // The new hunks are the same objects as in `files`: take their redacted copies. Found
  // by hunk, not by path, since a diff can name a path twice.
  const where = new Map<Hunk, [file: number, hunk: number]>();
  files.forEach((f, i) => f.hunks.forEach((h, j) => where.set(h, [i, j])));
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const review: PreparedDiff['review'] = { files: [], redacted: [], redactions: 0 };
  for (const file of plan.diff.files) {
    const first = file.hunks[0];
    // Files without hunks (binary, pure renames) are handed on whole.
    const i = first ? where.get(first)![0] : byPath.get(file.path)!;
    const hunks = file.hunks.map((h) => where.get(h)![1]);
    review.files.push(file);
    review.redacted.push({
      ...redacted.files[i]!,
      hunks: hunks.map((h) => redacted.files[i]!.hunks[h]!),
    });
    for (const h of hunks) review.redactions += redacted.hunkCounts[i]![h]!;
  }
  prepared.plan = plan;
  prepared.review = review;
  return prepared;
}

/**
 * `diff` itself when `prepareDiff` made it with these options; otherwise the diff
 * prepared now.
 */
export function toPreparedDiff(
  diff: UnifiedDiff | PreparedDiff,
  options: PrepareDiffOptions,
): PreparedDiff {
  if (!('review' in diff)) return prepareDiff(diff, options);
  if (diff.key === reviewKey(options) && diff.previous === options.previous) return diff;
  return prepareDiff(diff.diff, options);
}

/**
 * Tokens one chunk may use: input limit − fixed prompt parts − output reserve, with a 20%
 * margin because token counts are estimated. `fixedTokens` = system + tools + shared text;
 * by default the single-pass prompt without rules. Agentic parts get half, leaving room
 * for tool results.
 */
export function chunkBudget(
  model: ModelInfo,
  config: ReviewConfig,
  options: {
    maxChunkTokens?: number;
    maxOutputTokens?: number;
    fixedTokens?: number;
    agentic?: boolean;
  } = {},
): { chunkTokens: number; outputTokens: number } {
  const outputTokens = options.maxOutputTokens ?? Math.min(model.maxOutputTokens, 16_000);
  const fixed =
    (options.fixedTokens ??
      estimateTokens(buildSystemBlocks({ config, jsonOnly: !model.supportsTools })[0]!.text) +
        estimateTokens(JSON.stringify(REPORT_FINDINGS_TOOL))) +
    estimateTokens(buildUserPrompt('')) +
    200;
  // Some providers (Anthropic) count output inside the context window; reserve it.
  const available = Math.floor((model.maxInputTokens - fixed - outputTokens) * 0.8);
  const chunkTokens = Math.min(
    options.maxChunkTokens ?? 24_000,
    options.agentic ? Math.floor(available / 2) : available,
  );
  return { chunkTokens, outputTokens };
}

export interface PreparedReview {
  /** Files that will be reviewed (before redaction; used to restore quotes). */
  files: FileDiff[];
  /** Skipped files of what is sent now (none with a plan: its files are filtered already). */
  skipped: SkippedFile[];
  redacted: { files: FileDiff[]; count: number };
  chunks: Chunk[];
  outputTokens: number;
  mode: 'single-pass' | 'agentic';
  /** System blocks of every review request (prompt + rules). */
  system: { text: string; cache?: boolean }[];
  /** Changed-symbols index sent before each part's diff. */
  shared?: string;
  /** Tools sent with every review request. */
  tools: ToolDef[];
  /** Estimated tokens of the prefix shared by all parts (tools + system + shared). */
  sharedPrefixTokens: number;
  agentLimits: AgentLimits;
}

/**
 * Filter → redact → plan (unless `diff` is prepared already) → context → chunk. Throws
 * ReviewTooLargeError when the diff needs too many requests.
 */
export function prepareReview(
  diff: UnifiedDiff | PreparedDiff,
  options: PrepareOptions & { previous?: ReviewSnapshot; verify?: boolean },
): PreparedReview {
  return prepareParts(toPreparedDiff(diff, options), options);
}

/** Context → chunk, for what a prepared diff sends now. */
export function prepareParts(diff: PreparedDiff, options: PrepareOptions): PreparedReview {
  const { model, config } = options;
  const { plan, skipped, review } = diff;
  const jsonOnly = !model.supportsTools;
  const mode = resolveMode(options);
  const agentLimits = { ...DEFAULT_AGENT_LIMITS, ...options.agentLimits };

  const system = reviewSystem(options, mode);
  const tools = jsonOnly
    ? []
    : mode === 'agentic'
      ? [...reviewToolDefs(), REPORT_FINDINGS_TOOL]
      : [REPORT_FINDINGS_TOOL];
  const withContext = options.context ?? true;
  const shared = withContext
    ? renderChangedSymbols(changedSymbols(review.redacted, options.symbols))
    : undefined;
  const sharedPrefixTokens =
    estimateTokens(system.map((s) => s.text).join('\n')) +
    (tools.length ? estimateTokens(JSON.stringify(tools)) : 0) +
    (shared ? estimateTokens(shared) : 0);

  const { chunkTokens, outputTokens } = chunkBudget(model, config, {
    ...options,
    fixedTokens: sharedPrefixTokens,
    agentic: mode === 'agentic',
  });
  // NaN would fail every size check in the chunker and send the whole diff at once. Models
  // from a host's provider are checked already (`withModelValidation`); this catches a
  // model or `maxOutputTokens` a caller passes in directly.
  if (!Number.isFinite(chunkTokens) || !Number.isFinite(outputTokens)) {
    throw new Error(
      `${model.name} has an invalid token limit (input ${model.maxInputTokens}, output ${model.maxOutputTokens}).`,
    );
  }
  if (chunkTokens < 500) {
    throw new Error(`${model.name} has too small an input limit for a review.`);
  }
  const contextTokens = Math.min(3_000, Math.floor(chunkTokens * 0.25));
  const chunks = chunkFiles(review.redacted, {
    maxTokens: chunkTokens,
    ...(options.maxChunks !== undefined ? { maxChunks: options.maxChunks } : {}),
    ...(withContext
      ? {
          context: (file, hunks) =>
            buildFileContext(file, hunks, options.symbols?.get(file.path), {
              maxTokens: contextTokens,
            }),
        }
      : {}),
  });
  const prepared: PreparedReview = {
    files: review.files,
    skipped: plan ? [] : skipped,
    redacted: { files: review.redacted, count: review.redactions },
    chunks,
    outputTokens,
    mode,
    system,
    tools,
    sharedPrefixTokens,
    agentLimits,
  };
  if (shared) prepared.shared = shared;
  return prepared;
}
