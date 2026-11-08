import type { z } from 'zod';
import { noopLogger, type Logger } from '../logger';
import { collectChat, type CollectedResponse } from '../provider/collect';
import type {
  ContentPart,
  LLMProvider,
  Message,
  ModelInfo,
  ToolDef,
  Usage,
} from '../provider/types';
import { addUsage, emptyUsage, estimateTokens } from '../provider/usage';

/** A read-only tool the agent may call. `run` output goes back to the model as text. */
export interface AgentTool<I = unknown> {
  def: ToolDef;
  /** Validates (and may coerce) the model's input before `run`. */
  schema: z.ZodType<I>;
  run(input: I, signal: AbortSignal): Promise<string>;
  /** Short, code-free description of a call for the debug log, e.g. the path. */
  describe?(input: I): string;
}

export interface AgentLimits {
  /** Model requests for exploring, not counting the forced final turn and one repair. */
  maxTurns: number;
  /** Tool calls in total (the final tool doesn't count). */
  maxToolCalls: number;
  /** Input tokens summed over all requests (incl. cached). The loop wraps up past it. */
  tokenBudget: number;
  /** Each tool result is cut to this many characters. */
  maxResultChars: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxTurns: 8,
  maxToolCalls: 20,
  tokenBudget: 200_000,
  maxResultChars: 12_000,
};

export type AgentStop =
  /** The final tool was called and accepted. */
  | 'final'
  /** The final tool was called but its input was still invalid after one repair. */
  | 'invalidFinal'
  /** The model stopped without calling the final tool, even when asked to. */
  | 'noFinal'
  | 'cancelled';

/** Why the loop asked the model to finish early. */
export type WrapUpReason =
  'maxTurns' | 'maxToolCalls' | 'tokenBudget' | 'contextFull' | 'noToolCall';

/** `ok: false` sends `error` back to the model as the tool result and asks again (once). */
export type FinalCheck = (inputs: unknown[]) => { ok: true } | { ok: false; error: string };

export interface AgentLoopOptions {
  provider: LLMProvider;
  model: ModelInfo;
  system: { text: string; cache?: boolean }[];
  /** Starting conversation (usually one user message). Not modified. */
  messages: Message[];
  tools: AgentTool<never>[];
  /** Calling this tool ends the loop. */
  finalTool: ToolDef;
  checkFinal: FinalCheck;
  limits?: Partial<AgentLimits>;
  maxOutputTokens: number;
  signal: AbortSignal;
  logger?: Logger;
  /** Prefix for log lines, e.g. "part 2". */
  label?: string;
}

export interface AgentLoopResult {
  stop: AgentStop;
  /** Inputs of the last final-tool call (accepted or not). */
  final?: unknown[];
  /** Inputs of an earlier, rejected final call (kept so partial results aren't lost). */
  rejected?: unknown[];
  wrapUp?: WrapUpReason;
  /** Model requests made. */
  turns: number;
  /** Tool calls run (not counting the final tool). */
  toolCalls: number;
  usage: Usage;
  /** The whole conversation, for debugging. */
  messages: Message[];
}

/**
 * Bounded tool-use loop: the model calls read-only tools until it calls `finalTool`.
 * Limits on turns, tool calls and input tokens make it wrap up: the next request
 * asks for the final tool only. Malformed tool input and tool failures are returned to
 * the model as error results; they never throw. Provider errors do throw.
 * The tool list is identical on every request so the prompt cache stays valid.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { provider, model, signal, finalTool } = options;
  const logger = options.logger ?? noopLogger;
  const label = options.label ? `${options.label}: ` : '';
  const limits = { ...DEFAULT_AGENT_LIMITS, ...options.limits };
  const tools = new Map(options.tools.map((t) => [t.def.name, t]));
  const defs = [...options.tools.map((t) => t.def), finalTool];
  const messages: Message[] = [...options.messages];
  // Room for the request itself: the model's window minus output, with an estimate margin.
  const contextLimit = Math.floor((model.maxInputTokens - options.maxOutputTokens) * 0.8);

  let usage = emptyUsage();
  let turns = 0;
  let toolCalls = 0;
  let wrapUp: WrapUpReason | undefined;
  let forced = false;
  let nudges = 0;
  let rejected: unknown[] | undefined;
  const result = (stop: AgentStop, extra: Partial<AgentLoopResult> = {}): AgentLoopResult => ({
    stop,
    turns,
    toolCalls,
    usage,
    messages,
    ...(wrapUp ? { wrapUp } : {}),
    ...(rejected ? { rejected } : {}),
    ...extra,
  });
  // Exploring turns + forced final turn + one repair + one nudge: a hard stop.
  const maxRequests = limits.maxTurns + 3;

  while (turns < maxRequests) {
    if (signal.aborted) return result('cancelled');
    const response: CollectedResponse = await collectChat(
      provider.chat({
        model: model.id,
        system: options.system,
        messages: withRollingCache(messages),
        tools: defs,
        toolChoice: forced ? { name: finalTool.name } : 'auto',
        maxOutputTokens: options.maxOutputTokens,
        temperature: 0,
        signal,
      }),
    );
    turns++;
    usage = addUsage(usage, response.usage);
    if (response.stopReason === 'cancelled') return result('cancelled');

    const content = response.message.filter((p) => p.type !== 'text' || p.text.trim() !== '');
    if (content.length) messages.push({ role: 'assistant', content });
    const calls = response.toolCalls;
    const finals = calls.filter((c) => c.name === finalTool.name);
    const others = calls.filter((c) => c.name !== finalTool.name);

    if (finals.length) {
      const inputs = finals.map((c) => c.input);
      const check = options.checkFinal(inputs);
      if (check.ok) return result('final', { final: inputs });
      if (rejected) return result('invalidFinal', { final: inputs });
      rejected = inputs;
      logger.debug(`${label}agent: ${finalTool.name} input rejected, asking once more`);
      messages.push({
        role: 'user',
        content: [
          ...calls.map((c): ContentPart => ({
            type: 'tool_result',
            callId: c.id,
            content:
              c.name === finalTool.name
                ? `Error: ${check.error}`
                : `Not run: ${finalTool.name} was called in the same turn.`,
            isError: true,
          })),
          { type: 'text', text: `Call ${finalTool.name} again with the complete, corrected list.` },
        ],
      });
      forced = true;
      continue;
    }

    if (!others.length) {
      // Plain text (or a cut-off answer): ask for the final tool, once.
      if (nudges++ >= 1) return result('noFinal');
      wrapUp ??= 'noToolCall';
      forced = true;
      const cutOff = response.stopReason === 'max_tokens' ? 'Your answer was cut off. ' : '';
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${cutOff}Call ${finalTool.name} now with all findings (an empty list if there are none). Keep bodies short.`,
          },
        ],
      });
      continue;
    }

    if (forced) {
      // Asked for the final tool only, but the model explored again.
      if (nudges++ >= 1) return result('noFinal');
      messages.push({
        role: 'user',
        content: [
          ...others.map((c): ContentPart => ({
            type: 'tool_result',
            callId: c.id,
            content: 'Not run: the tool budget is used up.',
            isError: true,
          })),
          { type: 'text', text: `Call ${finalTool.name} now with what you have.` },
        ],
      });
      continue;
    }

    const results: ContentPart[] = [];
    for (const call of others) {
      if (toolCalls >= limits.maxToolCalls) {
        results.push({
          type: 'tool_result',
          callId: call.id,
          content: 'Not run: the tool call limit is reached.',
          isError: true,
        });
        continue;
      }
      toolCalls++;
      results.push(await runTool(call, tools, limits.maxResultChars, signal, logger, label, turns));
    }
    if (signal.aborted) return result('cancelled');

    const inputSoFar =
      usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const nextRequest =
      estimateTokens(options.system.map((s) => s.text).join('\n')) +
      estimateTokens(JSON.stringify(defs)) +
      estimateTokens(JSON.stringify(messages)) +
      estimateTokens(JSON.stringify(results));
    if (turns >= limits.maxTurns) wrapUp = 'maxTurns';
    else if (toolCalls >= limits.maxToolCalls) wrapUp = 'maxToolCalls';
    // Room for this exploring turn plus the final turn and a repair after it, so the
    // whole part stays within the budget (each request is at least as big as the last).
    else if (inputSoFar + 3 * nextRequest > limits.tokenBudget) wrapUp = 'tokenBudget';
    else if (nextRequest > contextLimit) wrapUp = 'contextFull';

    if (wrapUp) {
      forced = true;
      logger.debug(`${label}agent: wrapping up (${wrapUp})`);
      results.push({
        type: 'text',
        text: `That was your last exploring turn (${describeWrapUp(wrapUp)}). Call ${finalTool.name} now with all findings.`,
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return result('noFinal');
}

async function runTool(
  call: { id: string; name: string; input: unknown },
  tools: Map<string, AgentTool<never>>,
  maxChars: number,
  signal: AbortSignal,
  logger: Logger,
  label: string,
  turn: number,
): Promise<ContentPart> {
  const error = (message: string): ContentPart => {
    logger.debug(`${label}agent turn ${turn}: ${call.name} → error: ${message.slice(0, 200)}`);
    return { type: 'tool_result', callId: call.id, content: `Error: ${message}`, isError: true };
  };
  const tool = tools.get(call.name);
  if (!tool) return error(`unknown tool "${call.name}".`);
  const parsed = (tool.schema as z.ZodType<unknown>).safeParse(call.input ?? {});
  if (!parsed.success) {
    return error(
      `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
    );
  }
  const input = parsed.data as never;
  try {
    let text = await tool.run(input, signal);
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n… [truncated: ${text.length - maxChars} more characters. Ask for a narrower range.]`;
    }
    logger.debug(
      `${label}agent turn ${turn}: ${call.name}(${tool.describe?.(input) ?? ''}) → ${text.length} chars`,
    );
    logger.trace(`${label}agent ${call.name} result:\n${text}`);
    return { type: 'tool_result', callId: call.id, content: text || '(empty)' };
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}

function describeWrapUp(reason: WrapUpReason): string {
  switch (reason) {
    case 'maxTurns':
      return 'turn limit reached';
    case 'maxToolCalls':
      return 'tool call limit reached';
    case 'tokenBudget':
      return 'token budget used up';
    case 'contextFull':
      return 'the conversation is getting too long';
    case 'noToolCall':
      return 'no tool call';
  }
}

/**
 * Copy of the conversation with a cache hint on the last part, so each turn reads the
 * previous turns from the prompt cache. Earlier hints are dropped: providers allow only a
 * few breakpoints, and a read only needs the newest one.
 */
function withRollingCache(messages: Message[]): Message[] {
  const out = messages.map((m, i) =>
    i === 0
      ? m // keeps the shared-prefix hint of the first message (e.g. the changed-symbols index)
      : ({ ...m, content: m.content.map(stripCache) } as Message),
  );
  const last = out.at(-1);
  if (!last || last.role !== 'user') return out;
  const parts = [...last.content];
  const index = parts.length - 1;
  const part = parts[index]!;
  if (part.type === 'text' || part.type === 'tool_result') parts[index] = { ...part, cache: true };
  out[out.length - 1] = { ...last, content: parts };
  return out;
}

function stripCache(part: ContentPart): ContentPart {
  if ((part.type === 'text' || part.type === 'tool_result') && part.cache) {
    const { cache: _cache, ...rest } = part;
    return rest as ContentPart;
  }
  return part;
}
