import * as vscode from 'vscode';
import { ContextDataSource, createDataSource } from './dataSource';
import { HistoricalUsageReader } from './dataSource/historicalUsage';
import { StatusBarController } from './statusBar';
import { BreakdownPanel } from './webview/panel';

let activeDataSource: ContextDataSource | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const source = createDataSource();
  activeDataSource = source;
  const historicalUsage = new HistoricalUsageReader();
  const statusBar = new StatusBarController(source, historicalUsage);
  const panel = new BreakdownPanel(context.extensionUri, historicalUsage);

  context.subscriptions.push(
    statusBar,
    panel,
    vscode.commands.registerCommand('claudeContext.openPanel', () => panel.open(source)),
    source
  );
}

export async function deactivate(): Promise<void> {
  const source = activeDataSource;
  activeDataSource = undefined;
  await source?.whenIdle();
}
