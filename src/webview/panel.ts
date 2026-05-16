import * as vscode from 'vscode';
import type { ContextDataSource } from '../dataSource';
import { reconstructContextBreakdown } from '../contextReconstructor';
import dashboardHtml from './dashboard.html';

export class BreakdownPanel {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public open(source: ContextDataSource): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.postBreakdown(source);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'claudeContextBreakdown',
      'Claude Context Breakdown',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri]
      }
    );

    this.panel.webview.html = dashboardHtml;
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.postBreakdown(source);
  }

  private async postBreakdown(source: ContextDataSource): Promise<void> {
    const panel = this.panel;

    if (!panel) {
      return;
    }

    const breakdown = await reconstructContextBreakdown(source.getLatest());
    await panel.webview.postMessage({
      type: 'contextBreakdown',
      payload: breakdown
    });
  }
}
