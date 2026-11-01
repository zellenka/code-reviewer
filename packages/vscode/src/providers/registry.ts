import { ProviderError, type LLMProvider, type ModelInfo } from '@ai-review/core';
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'aiReview';

export interface ProviderEntry {
  provider: LLMProvider;
  label: string;
  /** False when the provider can't be used yet (e.g. no API key). */
  isAvailable(): boolean | Promise<boolean>;
}

export interface ActiveModel {
  provider: LLMProvider;
  model: ModelInfo;
}

export interface Selection {
  providerId: string;
  /** Empty = first model the provider lists. */
  modelId: string;
}

/**
 * Registered providers + the user's provider/model choice. The choice lives in
 * settings and is read on every request, so switching needs no reload.
 */
export class ProviderRegistry implements vscode.Disposable {
  private readonly entries = new Map<string, ProviderEntry>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  /** Fires when providers, availability, models or the selection change. */
  readonly onDidChange = this.changed.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) this.changed.fire();
      }),
      vscode.lm.onDidChangeChatModels(() => this.changed.fire()),
    );
  }

  /** Registers (or replaces) a provider. */
  register(id: string, entry: ProviderEntry): vscode.Disposable {
    this.entries.set(id, entry);
    this.changed.fire();
    return new vscode.Disposable(() => {
      if (this.entries.get(id) === entry) {
        this.entries.delete(id);
        this.changed.fire();
      }
    });
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.get(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Call when availability changes outside settings (e.g. API key set). */
  notifyChanged(): void {
    this.changed.fire();
  }

  getSelection(): Selection {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      providerId: config.get<string>('provider') || 'copilot',
      modelId: config.get<string>('model') ?? '',
    };
  }

  async setSelection(selection: Selection): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('provider', selection.providerId, targetFor(config, 'provider'));
    await config.update('model', selection.modelId, targetFor(config, 'model'));
  }

  /** Provider + model for the next request. Throws ProviderError when unusable. */
  async resolveActive(): Promise<ActiveModel> {
    const { providerId, modelId } = this.getSelection();
    const entry = this.entries.get(providerId);
    if (!entry) {
      throw new ProviderError(
        'unknown',
        `Unknown provider "${providerId}". Pick a model with "AI Review: Select Model".`,
      );
    }
    if (!(await entry.isAvailable())) {
      throw new ProviderError('auth', `${entry.label} is not set up yet.`, {
        provider: providerId,
      });
    }
    const models = await entry.provider.listModels();
    if (!models.length) {
      throw new ProviderError(
        'notFound',
        providerId === 'copilot'
          ? 'No Copilot models found. Install GitHub Copilot Chat and sign in, or pick another provider.'
          : `${entry.label} has no models.`,
        { provider: providerId },
      );
    }
    const model = modelId ? models.find((m) => m.id === modelId) : models[0];
    if (!model) {
      throw new ProviderError(
        'notFound',
        `Model "${modelId}" is not available from ${entry.label}. Pick another model.`,
        {
          provider: providerId,
        },
      );
    }
    return { provider: entry.provider, model };
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

/** Write where the value is currently defined, so a workspace setting isn't silently shadowed. */
function targetFor(config: vscode.WorkspaceConfiguration, key: string): vscode.ConfigurationTarget {
  const inspected = config.inspect(key);
  if (inspected?.workspaceFolderValue !== undefined)
    return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}
