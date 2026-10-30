import type { Logger } from '@ai-review/core';
import * as vscode from 'vscode';

/**
 * Logger backed by a LogOutputChannel. The level is controlled by VS Code
 * ("Developer: Set Log Level..." → AI Review), so no setting of our own is needed.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  error(message: string | Error, ...args: unknown[]): void {
    this.channel.error(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(message, ...args);
  }
  trace(message: string, ...args: unknown[]): void {
    this.channel.trace(message, ...args);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
