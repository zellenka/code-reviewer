import {
  collectChat,
  emptyUsage,
  addUsage,
  type Logger,
  type Message,
  type ToolDef,
  type Usage,
} from '@ai-review/core';
import * as vscode from 'vscode';
import { showProviderError } from '../providers/errorUi';
import type { ProviderRegistry } from '../providers/registry';

const ADD_TOOL: ToolDef = {
  name: 'add_numbers',
  description: 'Adds two integers and returns the sum.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};

export interface TestConnectionResult {
  ok: boolean;
  providerId?: string;
  modelId?: string;
  reply?: string;
  usage?: Usage;
}

/**
 * "AI Review: Test Model Connection" — one chat round trip with a tool call
 * against the selected model. Also the first (consent-triggering) Copilot request,
 * so it must only run from a user action.
 */
export async function testConnectionCommand(
  registry: ProviderRegistry,
  logger: Logger,
  options: { silent?: boolean } = {},
): Promise<TestConnectionResult> {
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AI Review: testing model connection…',
        cancellable: true,
      },
      (_progress, token) => runTest(registry, token),
    );
    if (!options.silent && result.ok) {
      const tokens = result.usage
        ? ` · ${result.usage.inputTokens + result.usage.outputTokens}${result.usage.estimated ? ' (est.)' : ''} tokens`
        : '';
      void vscode.window.showInformationMessage(
        `AI Review: ${result.modelId} works. Reply: "${result.reply}"${tokens}`,
      );
    }
    return result;
  } catch (err) {
    if (!options.silent) await showProviderError(err, logger);
    else logger.error(err instanceof Error ? err : String(err));
    return { ok: false };
  }
}

async function runTest(
  registry: ProviderRegistry,
  token: vscode.CancellationToken,
): Promise<TestConnectionResult> {
  const { provider, model } = await registry.resolveActive();
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());
  try {
    const base = {
      model: model.id,
      system: [
        {
          text: 'You are a test assistant. Use the add_numbers tool for arithmetic, then answer with just the number.',
        },
      ],
      tools: [ADD_TOOL],
      // Room for models that think before answering (thinking uses output tokens).
      maxOutputTokens: 8000,
      signal: controller.signal,
    };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'What is 17 + 25?' }] },
    ];

    const first = await collectChat(
      provider.chat({ ...base, messages, toolChoice: { name: ADD_TOOL.name } }),
    );
    let usage = addUsage(emptyUsage(), first.usage);
    const call = first.toolCalls[0];
    if (first.stopReason === 'cancelled') return { ok: false };
    if (first.stopReason === 'max_tokens') {
      throw new Error(`${model.name} ran out of output tokens before calling the test tool.`);
    }
    if (!call)
      throw new Error(
        `${model.name} did not call the test tool. Reply: ${first.text.slice(0, 200)}`,
      );

    const input = call.input as { a?: unknown; b?: unknown };
    const sum = Number(input.a) + Number(input.b);
    messages.push({ role: 'assistant', content: first.message });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', callId: call.id, content: String(sum) }],
    });

    const second = await collectChat(provider.chat({ ...base, messages, toolChoice: 'auto' }));
    usage = addUsage(usage, second.usage);
    if (second.stopReason === 'cancelled') return { ok: false };
    return {
      ok: true,
      providerId: provider.id,
      modelId: model.id,
      reply: second.text.trim(),
      usage,
    };
  } finally {
    sub.dispose();
  }
}
