import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ContextDataSource } from '../dataSource';
import { reconstructContextBreakdown, type ContextBreakdown } from '../contextReconstructor';
import {
  DEFAULT_BUDGET_5H,
  DEFAULT_BUDGET_7D,
  HistoricalUsageReader,
  type HistoricalUsageBudgets,
  type HistoricalUsageSnapshot
} from '../dataSource/historicalUsage';
import dashboardHtml from './dashboard.html';

type WebviewCommand =
  | {
      readonly type: 'copyCompact';
    }
  | {
      readonly type: 'startNewChat';
    };

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

interface WebviewSnapshotPayload {
  readonly breakdown: ContextBreakdown;
  readonly history?: WebviewHistoricalUsageSnapshot;
  readonly error?: string;
}

type WebviewOutgoingMessage =
  | {
      readonly type: 'contextSnapshot';
      readonly payload: WebviewSnapshotPayload;
    }
  | {
      readonly type: 'commandResult';
      readonly payload: { readonly message: string };
    }
  | {
      readonly type: 'newChatUnavailable';
      readonly payload: { readonly message: string };
    };

export class BreakdownPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly historicalUsage: HistoricalUsageReader;
  private readonly panelSubscriptions: vscode.Disposable[] = [];
  private postSequence = 0;

  public constructor(private readonly extensionUri: vscode.Uri, historicalUsage: HistoricalUsageReader) {
    this.historicalUsage = historicalUsage;
  }

  public dispose(): void {
    this.disposePanelSubscriptions();
    this.panel?.dispose();
    this.panel = undefined;
  }

  public open(source: ContextDataSource): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.postSnapshot(source);
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
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isWebviewCommand(message)) {
          return;
        }

        void this.handleMessage(panel, message);
      }),
      source.onDidChange(() => {
        void this.postSnapshot(source);
      })
    );

    void this.postSnapshot(source);
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
    const latest = source.getLatest();
    const [breakdown, history] = await Promise.all([
      reconstructContextBreakdown(latest, { workspaceRoot }),
      this.readHistoricalUsage()
    ]);

    if (this.panel !== panel || sequence !== this.postSequence) {
      return;
    }

    await this.postWebviewMessage(panel, {
      type: 'contextSnapshot',
      payload: {
        breakdown,
        history: history === undefined ? undefined : toWebviewHistoricalUsage(history),
        error: latest.error
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
    switch (message.type) {
      case 'copyCompact':
        await vscode.env.clipboard.writeText('/compact');
        await this.postWebviewMessage(panel, {
          type: 'commandResult',
          payload: {
            message: 'Copied /compact'
          }
        });
        return;
      case 'startNewChat': {
        const opened = await vscode.env.openExternal(
          vscode.Uri.parse('vscode://anthropic.claude-code/new-session')
        );

        if (!opened) {
          void vscode.window.showInformationMessage(
            'Start a new Claude Code chat from the Claude Code view, or run /clear in the terminal.'
          );
        }

        await this.postWebviewMessage(panel, {
          type: opened ? 'commandResult' : 'newChatUnavailable',
          payload: {
            message: opened
              ? 'Opening new Claude Code chat'
              : 'Start a new Claude Code chat from the Claude Code view, or run /clear in the terminal.'
          }
        });
        return;
      }
      default: {
        const exhaustiveCheck: never = message;
        return exhaustiveCheck;
      }
    }
  }

  private async postWebviewMessage(
    panel: vscode.WebviewPanel,
    message: WebviewOutgoingMessage
  ): Promise<void> {
    try {
      await panel.webview.postMessage(message);
    } catch {
      // The panel can be disposed between the guard and the send.
    }
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

function isWebviewCommand(value: unknown): value is WebviewCommand {
  return (
    isRecord(value) &&
    (value.type === 'copyCompact' || value.type === 'startNewChat')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
