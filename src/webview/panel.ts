import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ContextDataSource } from '../dataSource';
import { reconstructContextBreakdown } from '../contextReconstructor';
import {
  DEFAULT_BUDGET_5H,
  DEFAULT_BUDGET_7D,
  HistoricalUsageReader,
  type HistoricalUsageBudgets,
  type HistoricalUsageSnapshot
} from '../dataSource/historicalUsage';
import dashboardHtml from './dashboard.html';

interface WebviewCommand {
  readonly type?: unknown;
}

interface WebviewModelUsage {
  readonly model: string;
  readonly tokens5h: number;
  readonly tokens7d: number;
}

interface WebviewHistoricalUsageSnapshot {
  readonly tokens5h: number;
  readonly tokens7d: number;
  readonly pct5h: number;
  readonly pct7d: number;
  readonly hasData: boolean;
  readonly byModel: readonly WebviewModelUsage[];
}

export class BreakdownPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly historicalUsage = new HistoricalUsageReader();
  private readonly panelSubscriptions: vscode.Disposable[] = [];
  private postSequence = 0;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public dispose(): void {
    this.disposePanelSubscriptions();
    this.panel?.dispose();
    this.panel = undefined;
  }

  public open(source: ContextDataSource): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.postSnapshot(source);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeContextBreakdown',
      'Claude Context Breakdown',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: false
      }
    );

    this.panel = panel;
    panel.webview.html = dashboardHtml.replaceAll('{{nonce}}', getNonce());

    this.panelSubscriptions.push(
      panel.onDidDispose(() => {
        this.disposePanelSubscriptions();
        this.panel = undefined;
      }),
      panel.webview.onDidReceiveMessage((message: WebviewCommand) => {
        void this.handleMessage(panel, message);
      }),
      source.onDidChange(() => {
        void this.postSnapshot(source);
      })
    );

    this.postSnapshot(source);
  }

  private disposePanelSubscriptions(): void {
    while (this.panelSubscriptions.length > 0) {
      this.panelSubscriptions.pop()?.dispose();
    }
  }

  private async postSnapshot(source: ContextDataSource): Promise<void> {
    const panel = this.panel;
    const sequence = ++this.postSequence;

    if (!panel) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const [breakdown, history] = await Promise.all([
      reconstructContextBreakdown(source.getLatest(), { workspaceRoot }),
      this.readHistoricalUsage()
    ]);

    if (this.panel !== panel || sequence !== this.postSequence) {
      return;
    }

    await panel.webview.postMessage({
      type: 'contextSnapshot',
      payload: {
        breakdown,
        history: history === undefined ? undefined : toWebviewHistoricalUsage(history)
      }
    });
  }

  private async readHistoricalUsage(): Promise<HistoricalUsageSnapshot | undefined> {
    if (!vscode.workspace.getConfiguration('claudeContext').get<boolean>('showHistoricalUsage', true)) {
      return undefined;
    }

    try {
      return await this.historicalUsage.refresh(this.getHistoricalUsageBudgets());
    } catch {
      return undefined;
    }
  }

  private getHistoricalUsageBudgets(): HistoricalUsageBudgets {
    const config = vscode.workspace.getConfiguration('claudeContext');

    return {
      budget5h: config.get<number>('budget5h', DEFAULT_BUDGET_5H),
      budget7d: config.get<number>('budget7d', DEFAULT_BUDGET_7D)
    };
  }

  private async handleMessage(panel: vscode.WebviewPanel, message: WebviewCommand): Promise<void> {
    if (message.type === 'copyCompact') {
      await vscode.env.clipboard.writeText('/compact');
      await panel.webview.postMessage({
        type: 'commandResult',
        payload: {
          message: 'Copied /compact'
        }
      });
      return;
    }

    if (message.type === 'startNewChat') {
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse('vscode://anthropic.claude-code/new-session')
      );

      if (!opened) {
        void vscode.window.showInformationMessage(
          'Start a new Claude Code chat from the Claude Code view, or run /clear in the terminal.'
        );
      }

      await panel.webview.postMessage({
        type: opened ? 'commandResult' : 'newChatUnavailable',
        payload: {
          message: opened
            ? 'Opening new Claude Code chat'
            : 'Start a new Claude Code chat from the Claude Code view, or run /clear in the terminal.'
        }
      });
    }
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

function toWebviewHistoricalUsage(
  snapshot: HistoricalUsageSnapshot
): WebviewHistoricalUsageSnapshot {
  return {
    tokens5h: snapshot.tokens5h,
    tokens7d: snapshot.tokens7d,
    pct5h: snapshot.pct5h,
    pct7d: snapshot.pct7d,
    hasData: snapshot.hasData,
    byModel: Array.from(snapshot.byModel.entries())
      .map(([model, usage]) => ({
        model,
        tokens5h: usage.tokens5h,
        tokens7d: usage.tokens7d
      }))
      .filter((row) => row.tokens7d > 0)
      .sort((a, b) => b.tokens7d - a.tokens7d || a.model.localeCompare(b.model))
  };
}
