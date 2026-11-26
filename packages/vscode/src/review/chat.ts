import * as vscode from 'vscode';
import { userSetting } from '../settings';
import { COPILOT_CHAT_ID } from './exclusion';

export type ChatTarget = 'claude-code' | 'copilot';

export const CLAUDE_CODE_ID = 'anthropic.claude-code';

const LABELS: Record<ChatTarget, string> = {
  'claude-code': 'Claude Code',
  copilot: 'GitHub Copilot Chat',
};

/**
 * Hands a prompt to an agent chat, typed in but not sent: the user reads it and presses
 * Enter. Tests replace `installed` and `open`.
 */
export class AgentChat {
  installed: (target: ChatTarget) => boolean = (target) =>
    !!vscode.extensions.getExtension(target === 'copilot' ? COPILOT_CHAT_ID : CLAUDE_CODE_ID);

  open: (target: ChatTarget, prompt: string) => Promise<void> = openChat;

  /**
   * Sends `prompt` to the chat `aiReview.agentChat` names; "auto" uses the one installed,
   * and asks which when both are. False when none is available or the user cancelled.
   */
  async send(prompt: string): Promise<boolean> {
    const target = await this.choose();
    if (!target) return false;
    await this.open(target, prompt);
    return true;
  }

  private async choose(): Promise<ChatTarget | undefined> {
    const setting = userSetting<string>(vscode.workspace.getConfiguration('aiReview'), 'agentChat');
    if (setting === 'claude-code' || setting === 'copilot') {
      if (this.installed(setting)) return setting;
      void vscode.window.showWarningMessage(
        `AI Review: ${LABELS[setting]} isn't installed. Install it, or change the aiReview.agentChat setting.`,
      );
      return undefined;
    }
    const available = (Object.keys(LABELS) as ChatTarget[]).filter((t) => this.installed(t));
    if (available.length <= 1) {
      if (!available.length) {
        void vscode.window.showWarningMessage(
          'AI Review: no agent chat found. Install Claude Code or GitHub Copilot Chat to send findings to one.',
        );
      }
      return available[0];
    }
    const picked = await vscode.window.showQuickPick(
      available.map((target) => ({ label: LABELS[target], target })),
      { placeHolder: 'Send to which agent chat? (set aiReview.agentChat to stop asking)' },
    );
    return picked?.target;
  }
}

async function openChat(target: ChatTarget, prompt: string): Promise<void> {
  if (target === 'copilot') {
    // `isPartialQuery`: typed into the input, not sent.
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
      isPartialQuery: true,
      mode: 'agent',
    });
    return;
  }
  // What Claude Code's `vscode://anthropic.claude-code/open?prompt=…` link runs: a new
  // conversation with the prompt typed in (no session id). Called directly, so a long
  // prompt isn't squeezed through a URI.
  await vscode.commands.executeCommand(CLAUDE_CODE_OPEN, undefined, prompt);
}

const CLAUDE_CODE_OPEN = 'claude-vscode.primaryEditor.open';
