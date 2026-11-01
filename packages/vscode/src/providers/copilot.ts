import {
  ProviderError,
  isProviderError,
  type ChatEvent,
  type ChatRequest,
  type ContentPart,
  type LLMProvider,
  type Logger,
  type Message,
  type ModelInfo,
} from '@ai-review/core';
import * as vscode from 'vscode';

const PROVIDER = 'copilot';
/** vscode.lm doesn't expose output limits; this is a conservative assumption. */
const ASSUMED_MAX_OUTPUT = 4096;

/**
 * GitHub Copilot models via the VS Code Language Model API.
 * Notes on the API (engines.vscode 1.95):
 * - no system role → system text is sent as the first user message
 * - no usage reporting → tokens are counted with `model.countTokens` (marked `estimated`)
 * - "Required" tool mode can't name a tool → only the forced tool is sent
 * - the first `sendRequest` shows a consent dialog, so call `chat` only from a user action
 */
export class VsCodeLmProvider implements LLMProvider {
  readonly id = PROVIDER;

  constructor(private readonly logger: Logger) {}

  async listModels(): Promise<ModelInfo[]> {
    const models = await vscode.lm.selectChatModels({ vendor: PROVIDER });
    return models.map(toModelInfo);
  }

  async countTokens(model: string, text: string): Promise<number> {
    return (await this.getModel(model)).countTokens(text);
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    const model = await this.getModel(req.model);
    const messages = toLmMessages(req);
    const options = toLmOptions(req);
    this.logger.debug(
      `copilot: request model=${model.id} messages=${messages.length} tools=${options.tools?.length ?? 0}`,
    );

    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    req.signal.addEventListener('abort', onAbort, { once: true });

    const content: ContentPart[] = [];
    let text = '';
    let toolUse = false;
    try {
      const response = await model.sendRequest(messages, options, cts.token);
      for await (const part of response.stream) {
        if (req.signal.aborted) break;
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          appendText(content, part.value);
          yield { type: 'text', delta: part.value };
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolUse = true;
          content.push({ type: 'tool_call', id: part.callId, name: part.name, input: part.input });
          yield { type: 'tool_call', id: part.callId, name: part.name, input: part.input };
        }
      }
    } catch (err) {
      if (req.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      throw mapLmError(err);
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }

    yield { type: 'message', content };
    yield { type: 'usage', usage: await this.estimateUsage(model, messages, text, content) };
    yield { type: 'stop', reason: toolUse ? 'tool_use' : 'end' };
  }

  private async getModel(id: string): Promise<vscode.LanguageModelChat> {
    const [model] = await vscode.lm.selectChatModels({ vendor: PROVIDER, id });
    if (!model) {
      throw new ProviderError(
        'notFound',
        `Copilot model "${id}" is not available. Pick another model.`,
        {
          provider: PROVIDER,
        },
      );
    }
    return model;
  }

  private async estimateUsage(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    text: string,
    content: ContentPart[],
  ) {
    try {
      const counts = await Promise.all(messages.map((m) => model.countTokens(m)));
      const toolText = content
        .filter((p) => p.type === 'tool_call')
        .map((p) => JSON.stringify(p))
        .join('');
      return {
        inputTokens: counts.reduce((a, b) => a + b, 0),
        outputTokens: await model.countTokens(text + toolText),
        requests: 1,
        estimated: true,
      };
    } catch (err) {
      this.logger.debug(`copilot: token count failed: ${String(err)}`);
      return { inputTokens: 0, outputTokens: 0, requests: 1, estimated: true };
    }
  }
}

function toModelInfo(m: vscode.LanguageModelChat): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: ASSUMED_MAX_OUTPUT,
    supportsTools: true,
  };
}

function appendText(content: ContentPart[], value: string): void {
  const last = content.at(-1);
  if (last?.type === 'text') last.text += value;
  else content.push({ type: 'text', text: value });
}

/** Exported for tests. */
export function toLmMessages(req: ChatRequest): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  const system = req.system.map((s) => s.text).join('\n\n');
  if (system) out.push(vscode.LanguageModelChatMessage.User(system));
  for (const message of req.messages) out.push(toLmMessage(message));
  return out;
}

function toLmMessage(message: Message): vscode.LanguageModelChatMessage {
  if (message.role === 'user') {
    const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
    for (const part of message.content) {
      if (part.type === 'text') parts.push(new vscode.LanguageModelTextPart(part.text));
      if (part.type === 'tool_result') {
        const text = part.isError ? `Error: ${part.content}` : part.content;
        parts.push(
          new vscode.LanguageModelToolResultPart(part.callId, [
            new vscode.LanguageModelTextPart(text),
          ]),
        );
      }
    }
    return vscode.LanguageModelChatMessage.User(parts);
  }
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
  for (const part of message.content) {
    if (part.type === 'text') parts.push(new vscode.LanguageModelTextPart(part.text));
    if (part.type === 'tool_call') {
      const input = typeof part.input === 'object' && part.input !== null ? part.input : {};
      parts.push(new vscode.LanguageModelToolCallPart(part.id, part.name, input));
    }
  }
  return vscode.LanguageModelChatMessage.Assistant(parts);
}

/** Exported for tests. */
export function toLmOptions(req: ChatRequest): vscode.LanguageModelChatRequestOptions {
  const options: vscode.LanguageModelChatRequestOptions = {
    justification: 'AI Code Reviewer sends your code changes to the model to review them.',
  };
  const choice = req.toolChoice ?? 'auto';
  if (!req.tools?.length || choice === 'none') return options;

  let tools = req.tools;
  if (typeof choice === 'object') {
    tools = req.tools.filter((t) => t.name === choice.name);
    if (!tools.length) {
      throw new ProviderError(
        'unknown',
        `toolChoice names "${choice.name}", which is not in tools`,
        { provider: PROVIDER },
      );
    }
    options.toolMode = vscode.LanguageModelChatToolMode.Required;
  } else {
    options.toolMode = vscode.LanguageModelChatToolMode.Auto;
  }
  options.tools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return options;
}

/** Maps vscode.lm failures to ProviderError. Exported for tests. */
export function mapLmError(err: unknown): ProviderError {
  if (isProviderError(err)) return err;
  const opts = { provider: PROVIDER, cause: err };
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return new ProviderError(
          'consent',
          'AI Code Reviewer is not allowed to use Copilot models. Run the command again and choose "Allow", or check Copilot access for extensions.',
          opts,
        );
      case vscode.LanguageModelError.Blocked.name:
        return new ProviderError(
          'quota',
          'Copilot request was blocked, usually because a usage limit was reached. Try again later.',
          opts,
        );
      case vscode.LanguageModelError.NotFound.name:
        return new ProviderError(
          'notFound',
          'The selected Copilot model is no longer available. Pick another model.',
          opts,
        );
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  const detail = `${message} ${err instanceof Error && err.cause instanceof Error ? err.cause.message : ''}`;
  if (/rate.?limit|429|too many requests/i.test(detail))
    return new ProviderError('rateLimit', `Copilot rate limit: ${message}`, opts);
  if (/token limit|context length|too long|too large/i.test(detail))
    return new ProviderError('contextTooLong', message, opts);
  if (/quota|exceeded/i.test(detail)) return new ProviderError('quota', message, opts);
  if (/network|ECONN|ETIMEDOUT|fetch failed/i.test(detail))
    return new ProviderError('network', message, opts);
  return new ProviderError('unknown', `Copilot error: ${message}`, opts);
}
