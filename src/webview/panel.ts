import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ContextDataSource } from '../dataSource';
import { reconstructContextBreakdown, type ContextBreakdown } from '../contextReconstructor';
import { HistoricalUsageReader, type HistoricalUsageSnapshot } from '../dataSource/historicalUsage';
import { RateLimitReader, type RateLimitSnapshot } from '../dataSource/rateLimit';
import dashboardHtml from './dashboard.html';

const HISTORY_REFRESH_THROTTLE_MS = 30_000;
const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_CODE_NEW_SESSION_URI = 'vscode://anthropic.claude-code/new-session';
const NEW_CHAT_FALLBACK_MESSAGE =
  'Start a new Claude Code chat from the Claude Code view, or run /clear in the terminal.';
const CLAUDE_CODE_MISSING_MESSAGE =
  'Claude Code extension not found. Install the Anthropic Claude Code extension, or start a new chat manually.';

type WebviewCommand =
  | {
      readonly type: 'copyCompact';
    }
  | {
      readonly type: 'startNewChat';
    }
  | {
      readonly type: 'enableHistoricalUsage';
    };

interface WebviewModelUsage {
  readonly model: string;
  readonly tokens5h: number;
  readonly tokens7d: number;
}

interface WebviewHistoricalUsageSnapshot {
  readonly tokens5h: number;
  readonly tokens7d: number;
  readonly hasData: boolean;
  readonly byModel: readonly WebviewModelUsage[];
}

interface WebviewRateLimitSnapshot {
  readonly pct5h: number;
  readonly pct7d: number;
  readonly reset5h?: string;
  readonly reset7d?: string;
}

interface WebviewSnapshotPayload {
  readonly breakdown: ContextBreakdown;
  readonly showHistoricalUsage: boolean;
  readonly rateLimit?: WebviewRateLimitSnapshot;
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
  private source: ContextDataSource | undefined;
  private readonly historicalUsage: HistoricalUsageReader;
  private readonly rateLimit: RateLimitReader;
  private readonly panelSubscriptions: vscode.Disposable[] = [];
  private historySnapshot: HistoricalUsageSnapshot | undefined;
  private historyRefreshAt = 0;
  private historyRefreshing: Promise<HistoricalUsageSnapshot | undefined> | undefined;
  private postSequence = 0;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    historicalUsage: HistoricalUsageReader,
    rateLimit: RateLimitReader
  ) {
    this.historicalUsage = historicalUsage;
    this.rateLimit = rateLimit;
  }

  public dispose(): void {
    this.disposePanelSubscriptions();
    this.panel?.dispose();
    this.panel = undefined;
    this.source = undefined;
  }

  public open(source: ContextDataSource): void {
    this.source = source;

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
    const breakdown = await reconstructContextBreakdown(latest, { workspaceRoot });
    const showHistoricalUsage = this.isHistoricalUsageEnabled();

    if (this.panel !== panel || sequence !== this.postSequence) {
      return;
    }

    await this.postWebviewMessage(panel, {
      type: 'contextSnapshot',
      payload: {
        breakdown,
        showHistoricalUsage,
        error: latest.error
      }
    });

    void Promise.all([this.readRateLimit(), this.readHistoricalUsage()]).then(
      async ([rateLimit, history]) => {
        if (this.panel !== panel || sequence !== this.postSequence) {
          return;
        }

        await this.postWebviewMessage(panel, {
          type: 'contextSnapshot',
          payload: {
            breakdown,
            showHistoricalUsage,
            rateLimit: rateLimit === undefined ? undefined : toWebviewRateLimit(rateLimit),
            history: history === undefined ? undefined : toWebviewHistoricalUsage(history),
            error: latest.error
          }
        });
      }
    );
  }

  private async readHistoricalUsage(): Promise<HistoricalUsageSnapshot | undefined> {
    if (!this.isHistoricalUsageEnabled()) {
      return undefined;
    }

    const now = Date.now();

    if (this.historyRefreshing !== undefined) {
      return this.historyRefreshing;
    }

    if (this.historyRefreshAt !== 0 && now - this.historyRefreshAt < HISTORY_REFRESH_THROTTLE_MS) {
      const snapshot = this.historicalUsage.calculateSnapshot(now);
      this.historySnapshot = snapshot;
      return snapshot;
    }

    this.historyRefreshing = this.historicalUsage
      .refresh()
      .then((snapshot) => {
        this.historySnapshot = snapshot;
        this.historyRefreshAt = Date.now();
        return snapshot;
      })
      .catch(() => {
        return this.historySnapshot;
      })
      .finally(() => {
        this.historyRefreshing = undefined;
      });

    return this.historyRefreshing;
  }

  private readRateLimit(): Promise<RateLimitSnapshot | undefined> {
    if (!this.isHistoricalUsageEnabled()) {
      return Promise.resolve(undefined);
    }

    return this.rateLimit.refresh();
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
        const claudeCodeExtension = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);

        if (claudeCodeExtension === undefined) {
          void vscode.window.showInformationMessage(CLAUDE_CODE_MISSING_MESSAGE);
          await this.postWebviewMessage(panel, {
            type: 'newChatUnavailable',
            payload: {
              message: CLAUDE_CODE_MISSING_MESSAGE
            }
          });
          return;
        }

        const opened = await vscode.env.openExternal(
          vscode.Uri.parse(CLAUDE_CODE_NEW_SESSION_URI)
        );

        if (!opened) {
          void vscode.window.showInformationMessage(NEW_CHAT_FALLBACK_MESSAGE);
        }

        await this.postWebviewMessage(panel, {
          type: opened ? 'commandResult' : 'newChatUnavailable',
          payload: {
            message: opened ? 'Opening new Claude Code chat' : NEW_CHAT_FALLBACK_MESSAGE
          }
        });
        return;
      }
      case 'enableHistoricalUsage': {
        await vscode.workspace
          .getConfiguration('claudeContext')
          .update('showHistoricalUsage', true, vscode.ConfigurationTarget.Global);

        const source = this.source;
        if (source !== undefined) {
          await this.postSnapshot(source);
        }
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

  private isHistoricalUsageEnabled(): boolean {
    return vscode.workspace.getConfiguration('claudeContext').get<boolean>('showHistoricalUsage', false);
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function isWebviewCommand(value: unknown): value is WebviewCommand {
  return (
    isRecord(value) &&
    (value.type === 'copyCompact' ||
      value.type === 'startNewChat' ||
      value.type === 'enableHistoricalUsage')
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

function toWebviewRateLimit(snapshot: RateLimitSnapshot): WebviewRateLimitSnapshot {
  return {
    pct5h: snapshot.pct5h,
    pct7d: snapshot.pct7d,
    reset5h: snapshot.reset5h,
    reset7d: snapshot.reset7d
  };
}
