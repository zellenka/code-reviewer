import {
  CONFIG_FILE_NAME,
  applyUserThresholds,
  parseConfig,
  type Logger,
  type ReviewConfig,
  type Severity,
} from '@ai-review/core';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Loads `.codereview.yml` per repo root, caches it, and reloads when the file changes.
 * Invalid config → one warning per change + defaults; never throws.
 */
export class ReviewConfigService implements vscode.Disposable {
  private readonly cache = new Map<string, ReturnType<typeof parseConfig>>();
  private readonly warned = new Set<string>();
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly logger: Logger) {
    this.watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);
    const invalidate = (uri: vscode.Uri) => {
      const root = path.dirname(uri.fsPath);
      this.forget(root);
      this.logger.info(`${CONFIG_FILE_NAME} changed in ${root}; reloading`);
    };
    this.watcher.onDidChange(invalidate);
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  /** Repo config with the user's (stricter-only) threshold settings applied. */
  async get(root: string): Promise<ReviewConfig> {
    const key = cacheKey(root);
    let loaded = this.cache.get(key);
    if (!loaded) {
      let text: string | undefined;
      try {
        text = await readFile(path.join(root, CONFIG_FILE_NAME), 'utf8');
      } catch {
        text = undefined;
      }
      loaded = parseConfig(text, CONFIG_FILE_NAME);
      this.cache.set(key, loaded);
    }
    if (loaded.warnings.length && !this.warned.has(key)) {
      this.warned.add(key);
      for (const w of loaded.warnings) this.logger.warn(w);
      void vscode.window
        .showWarningMessage(
          `AI Review: problems in ${CONFIG_FILE_NAME} (using defaults for those settings): ${loaded.warnings[0]}${loaded.warnings.length > 1 ? ` (+${loaded.warnings.length - 1} more)` : ''}`,
          'Open File',
        )
        .then((choice) => {
          if (choice) {
            void vscode.window.showTextDocument(vscode.Uri.file(path.join(root, CONFIG_FILE_NAME)));
          }
        });
    }
    const settings = vscode.workspace.getConfiguration('aiReview');
    const severity = settings.get<string>('severityThreshold');
    return applyUserThresholds(loaded.config, {
      ...(severity ? { severityThreshold: severity as Severity } : {}),
      confidenceThreshold: settings.get<number>('confidenceThreshold') ?? 0,
    });
  }

  forget(root: string): void {
    this.cache.delete(cacheKey(root));
    this.warned.delete(cacheKey(root));
  }

  dispose(): void {
    this.watcher.dispose();
  }
}

function cacheKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
