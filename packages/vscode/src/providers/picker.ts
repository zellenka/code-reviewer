import type { ModelInfo } from '@ai-review/core';
import * as vscode from 'vscode';
import type { ProviderRegistry, Selection } from './registry';

interface ModelItem extends vscode.QuickPickItem {
  action: { kind: 'select'; selection: Selection } | { kind: 'command'; command: string };
}

/**
 * "AI Review: Select Model". Pass `selection` to choose without UI (tests, keybindings).
 * Returns the stored selection, or undefined if cancelled.
 */
export async function selectModelCommand(
  registry: ProviderRegistry,
  selection?: Partial<Selection>,
): Promise<Selection | undefined> {
  if (selection?.providerId) {
    const chosen = { providerId: selection.providerId, modelId: selection.modelId ?? '' };
    await registry.setSelection(chosen);
    return chosen;
  }

  const current = registry.getSelection();
  const items: ModelItem[] = [];
  for (const id of registry.ids()) {
    const entry = registry.get(id)!;
    items.push({
      label: entry.label,
      kind: vscode.QuickPickItemKind.Separator,
      action: { kind: 'command', command: '' },
    });
    if (!(await entry.isAvailable())) {
      items.push({
        label: '$(key) Set Anthropic API key…',
        detail: 'Needed to use Claude models with your own Anthropic account.',
        action: { kind: 'command', command: 'aiReview.setAnthropicApiKey' },
      });
      continue;
    }
    let models: ModelInfo[] = [];
    try {
      models = await entry.provider.listModels();
    } catch {
      // Shown as "no models" below.
    }
    if (!models.length) {
      items.push({
        label: '$(warning) No models available',
        detail: id === 'copilot' ? 'Install GitHub Copilot Chat and sign in.' : undefined,
        action: { kind: 'command', command: '' },
      });
    }
    for (const model of models) {
      const isCurrent = current.providerId === id && current.modelId === model.id;
      items.push({
        label: `${isCurrent ? '$(check) ' : ''}${model.name}`,
        description: describeModel(model),
        action: { kind: 'select', selection: { providerId: id, modelId: model.id } },
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'AI Review: Select Model',
    placeHolder: 'Model used for reviews',
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked.action.kind === 'command') {
    if (picked.action.command) await vscode.commands.executeCommand(picked.action.command);
    return undefined;
  }
  await registry.setSelection(picked.action.selection);
  return picked.action.selection;
}

function describeModel(model: ModelInfo): string {
  const parts = [model.id, `${Math.round(model.maxInputTokens / 1000)}K context`];
  if (model.pricing)
    parts.push(`$${model.pricing.inputPerMTok}/$${model.pricing.outputPerMTok} per MTok`);
  return parts.join(' · ');
}

/** Status bar item showing the active model; click opens the picker. */
export class ModelStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'aiReview.model',
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly subscription: vscode.Disposable;
  private version = 0;

  constructor(private readonly registry: ProviderRegistry) {
    this.item.name = 'AI Review Model';
    this.item.command = 'aiReview.selectModel';
    this.subscription = registry.onDidChange(() => void this.update());
    void this.update();
    this.item.show();
  }

  async update(): Promise<void> {
    const version = ++this.version;
    let text: string;
    let tooltip: string;
    try {
      const { model } = await this.registry.resolveActive();
      text = `$(sparkle) ${model.name}`;
      tooltip = `AI Review model: ${model.name} (${model.vendor}). Click to change.`;
    } catch (err) {
      text = '$(sparkle) Select model';
      tooltip = `AI Review: ${err instanceof Error ? err.message : String(err)} Click to pick a model.`;
    }
    if (version !== this.version) return; // a newer update finished first
    this.item.text = text;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
