/**
 * Provider-agnostic chat types. Every model backend (Copilot via vscode.lm,
 * Anthropic, mocks) implements `LLMProvider` with these shapes.
 */

export type JSONSchema = Record<string, unknown>;

export interface ModelPricing {
  /** USD per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  pricing?: ModelPricing;
  /**
   * Set when the provider caches prompt prefixes marked with `cache` hints.
   * `minTokens`: shorter prefixes are not cached.
   */
  promptCaching?: { minTokens: number };
}

export type ContentPart =
  /** `cache` = provider-agnostic cache breakpoint hint. Providers without caching ignore it. */
  | { type: 'text'; text: string; cache?: boolean }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean; cache?: boolean }
  /**
   * Provider-specific content that must be sent back unchanged when the
   * conversation continues (e.g. Anthropic thinking blocks). Other providers drop it.
   */
  | { type: 'opaque'; provider: string; data: unknown };

export type Message =
  { role: 'user'; content: ContentPart[] } | { role: 'assistant'; content: ContentPart[] };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/** `{ name }` asks the model to call exactly that tool. */
export type ToolChoice = 'auto' | 'none' | { name: string };

export interface ChatRequest {
  model: string;
  system: { text: string; cache?: boolean }[];
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  maxOutputTokens?: number;
  /** Hint only. Currently ignored: Anthropic's API rejects it and vscode.lm has no portable option. */
  temperature?: number;
  signal: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'cancelled';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requests: number;
  /** True when the provider doesn't report usage and the numbers are local estimates. */
  estimated?: boolean;
}

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  /**
   * The complete assistant message, in order. Emitted once, before `usage`/`stop`.
   * Append it to `messages` to continue the conversation (tool results etc.).
   */
  | { type: 'message'; content: ContentPart[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: StopReason };

export interface LLMProvider {
  readonly id: 'copilot' | 'anthropic' | (string & {});
  listModels(): Promise<ModelInfo[]>;
  /**
   * Streams one model response. Ends with exactly one `stop` event.
   * Cancellation via `req.signal` ends the stream with `stop: cancelled` (no throw).
   * Failures throw `ProviderError`.
   */
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
  countTokens(model: string, text: string): Promise<number>;
}
