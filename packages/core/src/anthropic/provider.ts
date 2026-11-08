import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaTextBlockParam,
  BetaTool,
  BetaToolChoice,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { noopLogger, type Logger } from '../logger';
import { ProviderError, isProviderError } from '../provider/errors';
import { withRetry, type RetryOptions } from '../provider/retry';
import { estimateTokens } from '../provider/usage';
import type {
  ChatEvent,
  ChatRequest,
  ContentPart,
  LLMProvider,
  Message,
  ModelInfo,
  StopReason,
} from '../provider/types';
import { mapAnthropicError } from './errors';
import { ANTHROPIC_MODELS, REFUSAL_FALLBACK_MODELS, mergeModels } from './models';

const PROVIDER = 'anthropic';
const MAX_CACHE_BREAKPOINTS = 4;
const DEFAULT_MAX_OUTPUT = 32_000;
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The slice of the SDK client this provider uses (injectable for tests). */
export interface AnthropicStreamLike extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}
export interface AnthropicClientLike {
  beta: {
    messages: {
      stream(
        params: BetaMessageStreamParams,
        options?: { signal?: AbortSignal },
      ): AnthropicStreamLike;
    };
  };
}

export interface AnthropicProviderOptions {
  /** The key, or a getter (e.g. from SecretStorage). Missing key → `auth` error. */
  apiKey?: string | (() => string | undefined | Promise<string | undefined>);
  /** Extra/overriding model entries, e.g. from settings. Read on every `listModels`. */
  modelOverrides?: () => readonly unknown[];
  /**
   * Retry the request on another model when a safety classifier refuses it
   * (server-side `fallbacks: "default"`). Security reviews can trip the cyber
   * classifier, so this is on by default.
   */
  refusalFallback?: boolean | (() => boolean);
  retry?: Omit<RetryOptions, 'signal' | 'logger'>;
  logger?: Logger;
  /** For tests: builds the SDK client from a key. */
  createClient?: (apiKey: string) => AnthropicClientLike;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = PROVIDER;
  private readonly logger: Logger;
  private client: { key: string; client: AnthropicClientLike } | undefined;
  /** Set when the account rejects the refusal-fallback beta; fallback stays off afterwards. */
  private fallbackRejected = false;

  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.logger = options.logger ?? noopLogger;
  }

  async listModels(): Promise<ModelInfo[]> {
    return mergeModels(ANTHROPIC_MODELS, this.options.modelOverrides?.() ?? []);
  }

  /** Local estimate; avoids a network round trip per chunk. */
  async countTokens(_model: string, text: string): Promise<number> {
    return estimateTokens(text);
  }

  chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    return withRetry(() => this.chatOnce(req), {
      ...this.options.retry,
      signal: req.signal,
      logger: this.logger,
    });
  }

  private async *chatOnce(req: ChatRequest): AsyncIterable<ChatEvent> {
    try {
      yield* this.request(req, this.fallbackEnabled());
    } catch (err) {
      // Some accounts don't have the fallback beta enabled; the API then rejects
      // every request. Retry once without it and keep it off for this session.
      if (!this.fallbackRejected && this.fallbackEnabled() && isBetaRejection(err)) {
        this.fallbackRejected = true;
        this.logger.warn(
          'anthropic: refusal fallback is not available for this account; disabling it',
        );
        yield* this.request(req, false);
        return;
      }
      throw err;
    }
  }

  private fallbackEnabled(): boolean {
    if (this.fallbackRejected) return false;
    const option = this.options.refusalFallback;
    return typeof option === 'function' ? option() : (option ?? true);
  }

  private async *request(req: ChatRequest, useFallback: boolean): AsyncIterable<ChatEvent> {
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    const client = await this.getClient();
    const models = await this.listModels();
    const params = buildParams(
      req,
      models.find((m) => m.id === req.model),
      useFallback,
    );
    this.logger.debug(
      `anthropic: request model=${params.model} messages=${params.messages.length} tools=${params.tools?.length ?? 0}`,
    );
    this.logger.trace('anthropic: request', params);

    let message: BetaMessage;
    try {
      const stream = client.beta.messages.stream(params, { signal: req.signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text };
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      if (req.signal.aborted || err instanceof APIUserAbortError) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      throw mapAnthropicError(err);
    }

    if (message.stop_reason === 'refusal') {
      const details = message.stop_details;
      const why = details?.explanation ?? details?.category ?? 'no details';
      throw new ProviderError('blocked', `The model declined to review this content (${why}).`, {
        provider: PROVIDER,
      });
    }

    const blocks = [...message.content];
    // A tool call cut off by the output limit has incomplete input: drop it so
    // nobody runs it. Callers see stop: max_tokens and can retry with more room.
    if (isTruncated(message.stop_reason) && blocks.at(-1)?.type === 'tool_use') blocks.pop();
    const content = blocks.map(fromAnthropicBlock);
    for (const part of content) {
      if (part.type === 'tool_call')
        yield { type: 'tool_call', id: part.id, name: part.name, input: part.input };
    }
    yield { type: 'message', content };

    const u = message.usage;
    yield {
      type: 'usage',
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        requests: 1,
      },
    };
    yield { type: 'stop', reason: mapStopReason(message.stop_reason) };
  }

  private async getClient(): Promise<AnthropicClientLike> {
    const source = this.options.apiKey;
    const key = (typeof source === 'function' ? await source() : source)?.trim();
    if (!key) {
      throw new ProviderError('auth', 'No Anthropic API key is set.', { provider: PROVIDER });
    }
    if (this.client?.key !== key) {
      const create =
        this.options.createClient ??
        // Retries are handled by withRetry so they are logged and cancellable.
        ((apiKey: string) =>
          new Anthropic({ apiKey, maxRetries: 0 }) as unknown as AnthropicClientLike);
      this.client = { key, client: create(key) };
    }
    return this.client.client;
  }
}

function isTruncated(reason: BetaMessage['stop_reason']): boolean {
  return reason === 'max_tokens' || reason === 'model_context_window_exceeded';
}

/** A 400 caused by the fallback beta header/parameter not being accepted. */
function isBetaRejection(err: unknown): boolean {
  if (!isProviderError(err) || err.kind !== 'unknown') return false;
  const cause = err.cause as { status?: unknown } | undefined;
  return cause?.status === 400 && /anthropic-beta|fallback/i.test(err.message);
}

function mapStopReason(reason: BetaMessage['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'end';
  }
}

/** Exported for tests. */
export function buildParams(
  req: ChatRequest,
  model: ModelInfo | undefined,
  refusalFallback: boolean,
): BetaMessageStreamParams {
  const breakpoints = { left: MAX_CACHE_BREAKPOINTS };
  const system: BetaTextBlockParam[] = req.system.map((s) =>
    textBlock(s.text, s.cache, breakpoints),
  );
  const tools = req.tools?.length ? req.tools : undefined;

  let toolChoice: BetaToolChoice | undefined;
  const choice = req.toolChoice ?? 'auto';
  if (tools) {
    if (choice === 'none') {
      toolChoice = { type: 'none' };
    } else if (choice === 'auto') {
      toolChoice = { type: 'auto' };
    } else {
      if (!tools.some((t) => t.name === choice.name)) {
        throw new ProviderError(
          'unknown',
          `toolChoice names "${choice.name}", which is not in tools`,
          {
            provider: PROVIDER,
          },
        );
      }
      // Current models (Opus 5.5, Sonnet 5.5, Fable 5.1) reject forced tool_choice
      // ("any"/"tool") with a 400, so ask for the tool in the prompt and allow at most
      // one call. Callers validate the result and retry if the tool wasn't called.
      toolChoice = { type: 'auto', disable_parallel_tool_use: true };
      system.push({
        type: 'text',
        text: `Respond by calling the \`${choice.name}\` tool exactly once. Do not answer in plain text.`,
      });
    }
  }

  const params: BetaMessageStreamParams = {
    model: req.model,
    max_tokens:
      req.maxOutputTokens ??
      Math.min(model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT, DEFAULT_MAX_OUTPUT),
    messages: req.messages.map((m) => toAnthropicMessage(m, breakpoints)),
    // `temperature` is not sent: the API version the SDK uses rejects sampling parameters.
  };
  if (system.length) params.system = system;
  if (tools) {
    params.tools = tools.map((t): BetaTool => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool.InputSchema,
    }));
  }
  if (toolChoice) params.tool_choice = toolChoice;
  if (refusalFallback && REFUSAL_FALLBACK_MODELS.has(req.model)) {
    params.betas = [REFUSAL_FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

function textBlock(
  text: string,
  cache: boolean | undefined,
  breakpoints: { left: number },
): BetaTextBlockParam {
  const block: BetaTextBlockParam = { type: 'text', text };
  if (takeBreakpoint(cache, breakpoints)) block.cache_control = { type: 'ephemeral' };
  return block;
}

/** True (and one breakpoint used up) when a cache hint can still get a breakpoint. */
function takeBreakpoint(cache: boolean | undefined, breakpoints: { left: number }): boolean {
  if (!cache || breakpoints.left <= 0) return false;
  breakpoints.left--;
  return true;
}

function toAnthropicMessage(message: Message, breakpoints: { left: number }): BetaMessageParam {
  const content: BetaContentBlockParam[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        content.push(textBlock(part.text, part.cache, breakpoints));
        break;
      case 'tool_call':
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} });
        break;
      case 'tool_result':
        content.push({
          type: 'tool_result',
          tool_use_id: part.callId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
          ...(takeBreakpoint(part.cache, breakpoints)
            ? { cache_control: { type: 'ephemeral' as const } }
            : {}),
        });
        break;
      case 'opaque':
        // Thinking / fallback blocks must be echoed back unchanged; other providers' parts are dropped.
        if (part.provider === PROVIDER) content.push(part.data as BetaContentBlockParam);
        break;
    }
  }
  return { role: message.role, content };
}

function fromAnthropicBlock(block: BetaContentBlock): ContentPart {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
    default:
      return { type: 'opaque', provider: PROVIDER, data: block };
  }
}
