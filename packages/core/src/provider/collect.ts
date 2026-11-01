import { emptyUsage, addUsage } from './usage';
import type { ChatEvent, ContentPart, StopReason, Usage } from './types';

export interface CollectedResponse {
  text: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  /** Full assistant message, ready to append to `messages`. */
  message: ContentPart[];
  usage: Usage;
  stopReason: StopReason;
}

/**
 * Drains a chat stream into one result. `onText` receives text deltas as they arrive.
 * If the provider sent no `message` event, it is rebuilt from text + tool calls.
 */
export async function collectChat(
  stream: AsyncIterable<ChatEvent>,
  onText?: (delta: string) => void,
): Promise<CollectedResponse> {
  let text = '';
  const toolCalls: CollectedResponse['toolCalls'] = [];
  let message: ContentPart[] | undefined;
  let usage = emptyUsage();
  let stopReason: StopReason = 'end';

  for await (const event of stream) {
    switch (event.type) {
      case 'text':
        text += event.delta;
        onText?.(event.delta);
        break;
      case 'tool_call':
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        break;
      case 'message':
        message = event.content;
        break;
      case 'usage':
        usage = addUsage(usage, event.usage);
        break;
      case 'stop':
        stopReason = event.reason;
        break;
    }
  }

  message ??= [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...toolCalls.map((c) => ({ type: 'tool_call' as const, ...c })),
  ];
  return { text, toolCalls, message, usage, stopReason };
}
