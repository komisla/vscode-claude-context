import * as vscode from 'vscode';
import { ContextDataSource, createDataSource } from './dataSource';
import { HistoricalUsageReader } from './dataSource/historicalUsage';
import { RateLimitReader } from './dataSource/rateLimit';
import { StatusBarController } from './statusBar';
import { BreakdownPanel } from './webview/panel';

let activeDataSource: ContextDataSource | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const source = createDataSource();
  activeDataSource = source;
  const historicalUsage = new HistoricalUsageReader();
  void historicalUsage.refresh();
  const rateLimit = new RateLimitReader();
  const statusBar = new StatusBarController(source, rateLimit);
  const panel = new BreakdownPanel(context.extensionUri, historicalUsage, rateLimit);

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
