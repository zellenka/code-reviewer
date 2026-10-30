import { PRODUCT_NAME } from '@ai-review/core';
import * as vscode from 'vscode';
import { OutputChannelLogger } from './logger';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new OutputChannelLogger(PRODUCT_NAME);
  context.subscriptions.push(logger);
  logger.info(`${PRODUCT_NAME} activated (v${context.extension.packageJSON.version})`);

  context.subscriptions.push(
    vscode.commands.registerCommand('aiReview.hello', () => {
      const message = `${PRODUCT_NAME}: Hello! The extension is running.`;
      logger.info('hello command invoked');
      void vscode.window.showInformationMessage(message);
      return message;
    }),
    vscode.commands.registerCommand('aiReview.showLog', () => logger.show()),
  );
}

export function deactivate(): void {}
