import * as vscode from 'vscode';
import { createDataSource } from './dataSource';
import { StatusBarController } from './statusBar';
import { BreakdownPanel } from './webview/panel';

export function activate(context: vscode.ExtensionContext): void {
  const source = createDataSource();
  const statusBar = new StatusBarController(source);
  const panel = new BreakdownPanel(context.extensionUri);

  context.subscriptions.push(
    statusBar,
    panel,
    vscode.commands.registerCommand('claudeContext.openPanel', () => panel.open(source)),
    source
  );
}

export function deactivate(): void {}
