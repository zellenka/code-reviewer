import { toProviderError, type Logger } from '@ai-review/core';
import * as vscode from 'vscode';

/**
 * Shows a provider failure as a short message with a fix-it action instead of a stack trace.
 * The full error goes to the log.
 */
export async function showProviderError(err: unknown, logger: Logger): Promise<void> {
  const error = toProviderError(err);
  logger.error(error);

  const actions: { title: string; command: string }[] = [];
  switch (error.kind) {
    case 'auth':
      if (error.provider === 'anthropic') {
        actions.push({ title: 'Set API Key', command: 'aiReview.setAnthropicApiKey' });
      }
      actions.push({ title: 'Select Model', command: 'aiReview.selectModel' });
      break;
    case 'notFound':
    case 'consent':
    case 'unknown':
      actions.push({ title: 'Select Model', command: 'aiReview.selectModel' });
      break;
  }
  actions.push({ title: 'Show Log', command: 'aiReview.showLog' });

  const picked = await vscode.window.showErrorMessage(
    `AI Review: ${error.message}`,
    ...actions.map((a) => a.title),
  );
  const action = actions.find((a) => a.title === picked);
  if (action) await vscode.commands.executeCommand(action.command);
}
