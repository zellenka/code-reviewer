import { redactPromptText } from '../review/redact';
import type { ChatRequest, ContentPart, LLMProvider, Message } from './types';

/** Marks a wrapped provider, also across bundles (the extension bundles its own core). */
const REDACTING = Symbol.for('ai-review.withSecretRedaction');

/**
 * `provider`, with the known secret formats (the diff redaction's patterns, not the
 * high-entropy heuristic) redacted from all text it is sent: system blocks, message text
 * and tool results (A1). Defence in depth: each sender redacts what it sends already. The
 * model's own tool calls, provider data (e.g. signed thinking blocks) and tool definitions
 * are sent as they are. Deterministic, so cached prompt prefixes still match; the caller's
 * request is not changed. Applied once, however often it wraps.
 */
export function withSecretRedaction(provider: LLMProvider): LLMProvider {
  if (REDACTING in provider) return provider;
  const wrapped: LLMProvider & { [REDACTING]: true } = {
    [REDACTING]: true,
    id: provider.id,
    listModels: () => provider.listModels(),
    countTokens: (model, text) => provider.countTokens(model, text),
    chat: (req) => provider.chat(redactRequest(req)),
  };
  return wrapped;
}

function redactRequest(req: ChatRequest): ChatRequest {
  return {
    ...req,
    system: req.system.map((block) => {
      const text = redactPromptText(block.text);
      return text === block.text ? block : { ...block, text };
    }),
    messages: req.messages.map(redactMessage),
  };
}

function redactMessage(message: Message): Message {
  const content = message.content.map(redactPart);
  return content.every((p, i) => p === message.content[i]) ? message : { ...message, content };
}

function redactPart(part: ContentPart): ContentPart {
  if (part.type === 'text') {
    const text = redactPromptText(part.text);
    return text === part.text ? part : { ...part, text };
  }
  if (part.type === 'tool_result') {
    const content = redactPromptText(part.content);
    return content === part.content ? part : { ...part, content };
  }
  return part;
}
