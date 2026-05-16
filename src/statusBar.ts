import * as vscode from 'vscode';
import type { ContextDataSource, ContextUpdate } from './dataSource';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  private latest: ContextUpdate | undefined;

  public constructor(source: ContextDataSource, context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeContext.openPanel';
    this.item.name = 'Claude Context Monitor';

    this.subscriptions.push(
      this.item,
      source.onDidChange((update) => {
        this.latest = update;
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('claudeContext.hideBelow')) {
          this.render();
        }
      })
    );

    context.subscriptions.push(...this.subscriptions);
    this.render();
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private render(): void {
    const hideBelow = vscode.workspace
      .getConfiguration('claudeContext')
      .get<number>('hideBelow', 40);

    if (this.latest?.fillPercent !== undefined) {
      const fillPercent = Math.round(this.latest.fillPercent);

      if (fillPercent < hideBelow) {
        this.item.hide();
        return;
      }

      this.item.text = `ctx ${fillPercent}%`;
      this.item.tooltip = this.latest.sessionPath
        ? `Claude context fill: ${fillPercent}%\n${this.latest.sessionPath}`
        : `Claude context fill: ${fillPercent}%`;
      this.item.backgroundColor =
        fillPercent >= 60 ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      this.item.show();
      return;
    }

    this.item.text = 'ctx —';
    this.item.tooltip = this.latest?.error ?? 'Claude Code session not found';
    this.item.backgroundColor = undefined;
    this.item.show();
  }
}
