import {
  runAgentLoop,
  type AgentLimits,
  type AgentStop,
  type AgentTool,
  type WrapUpReason,
} from '../agent/loop';
import type { ReviewConfig } from '../config/schema';
import type { Logger } from '../logger';
import { noopLogger } from '../logger';
import { collectChat, type CollectedResponse } from '../provider/collect';
import type { ContentPart, LLMProvider, Message, ModelInfo, Usage } from '../provider/types';
import { addUsage, emptyUsage } from '../provider/usage';
import { REPORT_FINDINGS_TOOL, REPORT_TOOL_NAME, extractJson, parseFindingsInput } from './output';
import { buildSystemBlocks, buildUserPrompt } from './prompt';
import type { ParseOutcome, RawFinding } from './types';

export interface ReviewChunkOptions {
  provider: LLMProvider;
  model: ModelInfo;
  config: ReviewConfig;
  /** Rendered diff of the chunk. */
  diff: string;
  signal: AbortSignal;
  maxOutputTokens: number;
  logger?: Logger;
  /** System blocks (prompt + repo rules). Default: built from `config`. */
  system?: { text: string; cache?: boolean }[];
  /** Sent before the diff in every part of a review (changed-symbols index), with a cache hint. */
  shared?: string;
  /** Agentic mode: the model explores with these tools before reporting. */
  agent?: { tools: AgentTool<never>[]; limits: AgentLimits };
  /** For log lines, e.g. "part 2". */
  label?: string;
}

export interface AgentChunkStats {
  turns: number;
  toolCalls: number;
  stop: AgentStop;
  wrapUp?: WrapUpReason;
}

export interface ChunkReview {
  findings: RawFinding[];
  /** Findings that failed validation even after the repair attempt. */
  invalid: number;
  outcome: ParseOutcome;
  usage: Usage;
  agent?: AgentChunkStats;
}

type Attempt =
  { kind: 'ok'; findings: RawFinding[]; errors: string[] } | { kind: 'none'; reason: string };

/**
 * Reviews one chunk: asks for a forced `report_findings` call, validates it, and on
 * invalid or missing output asks once more with the problems listed.
 * Models without tools get the JSON-in-text variant.
 */
export async function reviewChunk(options: ReviewChunkOptions): Promise<ChunkReview> {
  const { provider, model, config, signal } = options;
  const logger = options.logger ?? noopLogger;
  const jsonOnly = !model.supportsTools;
  if (options.agent && !jsonOnly) return reviewChunkAgentic(options, options.agent);
  const system = options.system ?? buildSystemBlocks({ config, jsonOnly });
  const messages: Message[] = [{ role: 'user', content: userContent(options) }];
  const request = () =>
    collectChat(
      provider.chat({
        model: model.id,
        system,
        messages,
        maxOutputTokens: options.maxOutputTokens,
        temperature: 0,
        signal,
        ...(jsonOnly
          ? {}
          : { tools: [REPORT_FINDINGS_TOOL], toolChoice: { name: REPORT_TOOL_NAME } }),
      }),
    );

  let usage = emptyUsage();
  const first = await request();
  usage = addUsage(usage, first.usage);
  if (first.stopReason === 'cancelled')
    return { findings: [], invalid: 0, outcome: 'cancelled', usage };

  const firstAttempt = interpret(first, jsonOnly);
  if (firstAttempt.kind === 'ok' && firstAttempt.errors.length === 0) {
    return { findings: firstAttempt.findings, invalid: 0, outcome: 'valid', usage };
  }

  // One repair attempt.
  const problem =
    firstAttempt.kind === 'ok'
      ? `Some findings were invalid:\n${firstAttempt.errors.join('\n')}`
      : firstAttempt.reason;
  logger.debug(`review output needs repair: ${problem.slice(0, 300)}`);
  appendRepair(messages, first, problem, jsonOnly);

  const second = await request();
  usage = addUsage(usage, second.usage);
  if (second.stopReason === 'cancelled') {
    // Keep what was valid in the first answer.
    const kept = firstAttempt.kind === 'ok' ? firstAttempt.findings : [];
    return {
      findings: kept,
      invalid: firstAttempt.kind === 'ok' ? firstAttempt.errors.length : 0,
      outcome: 'cancelled',
      usage,
    };
  }
  const secondAttempt = interpret(second, jsonOnly);
  if (secondAttempt.kind === 'ok' && secondAttempt.errors.length === 0) {
    return { findings: secondAttempt.findings, invalid: 0, outcome: 'repaired', usage };
  }
  // Keep the better of the two partial answers.
  const best = [firstAttempt, secondAttempt]
    .filter((a): a is Extract<Attempt, { kind: 'ok' }> => a.kind === 'ok')
    .sort((a, b) => b.findings.length - a.findings.length)[0];
  if (best) {
    return { findings: best.findings, invalid: best.errors.length, outcome: 'partial', usage };
  }
  logger.warn(
    `${model.name} did not return usable findings: ${secondAttempt.kind === 'none' ? secondAttempt.reason : ''}`,
  );
  return { findings: [], invalid: 0, outcome: 'failed', usage };
}

function userContent(options: Pick<ReviewChunkOptions, 'diff' | 'shared'>): ContentPart[] {
  const diff: ContentPart = { type: 'text', text: buildUserPrompt(options.diff) };
  return options.shared ? [{ type: 'text', text: options.shared, cache: true }, diff] : [diff];
}

/**
 * Agentic variant: the model may explore with read-only tools, then calls
 * `report_findings`, which is validated (one repair round inside the loop).
 */
async function reviewChunkAgentic(
  options: ReviewChunkOptions,
  agent: NonNullable<ReviewChunkOptions['agent']>,
): Promise<ChunkReview> {
  const { provider, model, config, signal } = options;
  const logger = options.logger ?? noopLogger;
  const system =
    options.system ??
    buildSystemBlocks({
      config,
      agent: { maxTurns: agent.limits.maxTurns, maxToolCalls: agent.limits.maxToolCalls },
    });
  const loop = await runAgentLoop({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: userContent(options) }],
    tools: agent.tools,
    finalTool: REPORT_FINDINGS_TOOL,
    checkFinal: (inputs) => {
      const attempt = interpretInputs(inputs);
      if (attempt.kind === 'ok' && !attempt.errors.length) return { ok: true };
      return {
        ok: false,
        error:
          attempt.kind === 'ok'
            ? `Some findings were invalid:\n${attempt.errors.join('\n')}`
            : attempt.reason,
      };
    },
    limits: agent.limits,
    maxOutputTokens: options.maxOutputTokens,
    signal,
    logger,
    ...(options.label ? { label: options.label } : {}),
  });
  const stats: AgentChunkStats = { turns: loop.turns, toolCalls: loop.toolCalls, stop: loop.stop };
  if (loop.wrapUp) stats.wrapUp = loop.wrapUp;
  const base = { usage: loop.usage, agent: stats };
  const final = loop.final ? interpretInputs(loop.final) : undefined;
  const earlier = loop.rejected ? interpretInputs(loop.rejected) : undefined;

  if (loop.stop === 'final' && final?.kind === 'ok') {
    return {
      ...base,
      findings: final.findings,
      invalid: 0,
      outcome: loop.rejected ? 'repaired' : 'valid',
    };
  }
  const best = [final, earlier]
    .filter((a): a is Extract<Attempt, { kind: 'ok' }> => a?.kind === 'ok')
    .sort((a, b) => b.findings.length - a.findings.length)[0];
  if (loop.stop === 'cancelled') {
    return {
      ...base,
      findings: best?.findings ?? [],
      invalid: best?.errors.length ?? 0,
      outcome: 'cancelled',
    };
  }
  if (best) {
    return { ...base, findings: best.findings, invalid: best.errors.length, outcome: 'partial' };
  }
  logger.warn(`${model.name} did not report findings (agent stopped: ${loop.stop})`);
  return { ...base, findings: [], invalid: 0, outcome: 'failed' };
}

/** Validates the inputs of one or more `report_findings` calls together. */
function interpretInputs(inputs: unknown[]): Attempt {
  const findings: RawFinding[] = [];
  const errors: string[] = [];
  let usable = false;
  for (const input of inputs) {
    const parsed = parseFindingsInput(input);
    if (!parsed) continue;
    usable = true;
    findings.push(...parsed.findings);
    errors.push(...parsed.errors);
  }
  if (usable) return { kind: 'ok', findings, errors };
  return {
    kind: 'none',
    reason: `The ${REPORT_TOOL_NAME} input must be an object like {"findings": [...]}.`,
  };
}

function interpret(response: CollectedResponse, jsonOnly: boolean): Attempt {
  const calls = response.toolCalls.filter((c) => c.name === REPORT_TOOL_NAME);
  if (calls.length) return interpretInputs(calls.map((c) => c.input));
  // No tool call: accept JSON in the text (fallback for models that ignore tools).
  const json = extractJson(response.text);
  const parsed = json === undefined ? undefined : parseFindingsInput(json);
  if (parsed) return { kind: 'ok', ...parsed };
  if (response.stopReason === 'max_tokens') {
    return {
      kind: 'none',
      reason:
        'Your answer was cut off at the output limit. Report fewer findings with shorter bodies.',
    };
  }
  return {
    kind: 'none',
    reason: jsonOnly
      ? 'Reply with only the JSON object {"findings": [...]} in a ```json code block.'
      : `You must call the ${REPORT_TOOL_NAME} tool (with an empty list if there are no issues).`,
  };
}

function appendRepair(
  messages: Message[],
  response: CollectedResponse,
  problem: string,
  jsonOnly: boolean,
): void {
  const content = response.message.filter((p) => p.type !== 'text' || p.text.trim() !== '');
  const toolCalls = content.filter(
    (p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call',
  );
  if (content.length) messages.push({ role: 'assistant', content });

  const retry = jsonOnly
    ? 'Send the complete corrected JSON object again.'
    : `Call ${REPORT_TOOL_NAME} again with the complete, corrected list of findings.`;
  if (toolCalls.length) {
    // Every tool call needs a result before the conversation can continue.
    messages.push({
      role: 'user',
      content: [
        ...toolCalls.map((c) => ({
          type: 'tool_result' as const,
          callId: c.id,
          content: c.name === REPORT_TOOL_NAME ? `Error: ${problem}` : 'Error: unknown tool.',
          isError: true,
        })),
        { type: 'text', text: retry },
      ],
    });
  } else {
    messages.push({ role: 'user', content: [{ type: 'text', text: `${problem}\n${retry}` }] });
  }
}
