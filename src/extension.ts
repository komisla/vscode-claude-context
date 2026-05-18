import * as vscode from 'vscode';
import { ContextDataSource, createDataSource } from './dataSource';
import { HistoricalUsageReader } from './dataSource/historicalUsage';
import { RateLimitReader } from './dataSource/rateLimit';
import { StatusBarController } from './statusBar';
import { BreakdownPanel } from './webview/panel';

let activeDataSource: ContextDataSource | undefined;
let activeStatusBar: StatusBarController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const source = createDataSource();
  activeDataSource = source;
  const historicalUsage = new HistoricalUsageReader();
  historicalUsage.refresh().catch((err: unknown) => {
    globalThis.console.warn('[vscode-claude-context] historical usage initial refresh failed:', err);
  });
  const rateLimit = new RateLimitReader();
  const statusBar = new StatusBarController(source, rateLimit);
  activeStatusBar = statusBar;
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
  const statusBar = activeStatusBar;
  activeDataSource = undefined;
  activeStatusBar = undefined;
  await Promise.all([source?.whenIdle(), statusBar?.whenIdle()]);
}
