import * as vscode from 'vscode';

const SECRET_KEY = 'aiReview.anthropicApiKey';

/**
 * Anthropic API key in VS Code SecretStorage (OS keychain). Never written to settings.
 * Keeps a cached "is set" flag so availability checks are synchronous.
 */
export class AnthropicKeyStore implements vscode.Disposable {
  private hasKeyCache = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;

  private constructor(private readonly secrets: vscode.SecretStorage) {
    this.subscription = secrets.onDidChange(async (e) => {
      if (e.key !== SECRET_KEY) return;
      await this.refresh();
      this.changed.fire();
    });
  }

  static async create(secrets: vscode.SecretStorage): Promise<AnthropicKeyStore> {
    const store = new AnthropicKeyStore(secrets);
    await store.refresh();
    return store;
  }

  get hasKey(): boolean {
    return this.hasKeyCache;
  }

  async get(): Promise<string | undefined> {
    return (await this.secrets.get(SECRET_KEY)) || undefined;
  }

  async set(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key.trim());
    this.hasKeyCache = true;
    this.changed.fire();
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.hasKeyCache = false;
    this.changed.fire();
  }

  private async refresh(): Promise<void> {
    this.hasKeyCache = Boolean(await this.get());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

/** "AI Review: Set Anthropic API Key". `key` may be passed programmatically (tests). */
export async function setApiKeyCommand(store: AnthropicKeyStore, key?: string): Promise<boolean> {
  const value =
    key ??
    (await vscode.window.showInputBox({
      title: 'Anthropic API Key',
      prompt:
        'Create a key at console.anthropic.com. It is stored in your OS keychain, not in settings.',
      placeHolder: 'sk-ant-...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length < 20 ? 'This does not look like an API key.' : undefined,
    }));
  if (!value?.trim()) return false;
  await store.set(value);
  if (key === undefined) void vscode.window.showInformationMessage('Anthropic API key saved.');
  return true;
}

/** "AI Review: Clear Anthropic API Key". */
export async function clearApiKeyCommand(store: AnthropicKeyStore): Promise<void> {
  await store.clear();
  void vscode.window.showInformationMessage('Anthropic API key removed.');
}
