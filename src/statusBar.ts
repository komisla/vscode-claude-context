import * as vscode from 'vscode';
import { clearInterval, setInterval } from 'timers';
import type { ContextDataSource, ContextUpdate } from './dataSource';
import {
  DEFAULT_BUDGET_5H,
  DEFAULT_BUDGET_7D,
  HistoricalUsageReader,
  type HistoricalUsageBudgets,
  type HistoricalUsageSnapshot
} from './dataSource/historicalUsage';
import { buildTooltipText } from './statusBarFormatting';

const HISTORY_REFRESH_MS = 5 * 60 * 1_000;

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly historicalUsage: HistoricalUsageReader;
  private disposed = false;
  private historyRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private historyRefreshing: Promise<void> | undefined;
  private latest: ContextUpdate | undefined;
  private latestHistory: HistoricalUsageSnapshot | undefined;

  public constructor(source: ContextDataSource, historicalUsage: HistoricalUsageReader) {
    this.historicalUsage = historicalUsage;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'claudeContext.openPanel';
    this.item.name = 'Claude Context Monitor';

    this.subscriptions.push(
      this.item,
      source.onDidChange((update) => {
        this.latest = update;
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('claudeContext')) {
          this.render();

          if (
            event.affectsConfiguration('claudeContext.showHistoricalUsage') ||
            event.affectsConfiguration('claudeContext.budget5h') ||
            event.affectsConfiguration('claudeContext.budget7d')
          ) {
            this.scheduleHistoryRefresh();
          }
        }
      })
    );

    this.render();
  }

  public dispose(): void {
    this.disposed = true;
    this.stopHistoryTimer();

    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private render(): void {
    if (this.disposed) {
      return;
    }

    const config = vscode.workspace.getConfiguration('claudeContext');
    const hideBelow = config.get<number>('hideBelow', 0);
    const showHistoricalUsage = config.get<boolean>('showHistoricalUsage', true);

    if (this.latest?.fillPercent === undefined) {
      this.stopHistoryTimer();
      this.item.text = '$(hubot) ctx idle';
      this.item.tooltip = 'Claude Context Monitor: waiting for an active Claude Code session';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const fillPercent = Math.round(this.latest.fillPercent);

    if (hideBelow > 0 && fillPercent < hideBelow) {
      this.stopHistoryTimer();
      this.item.hide();
      return;
    }

    this.startHistoryTimerIfNeeded();

    const history =
      showHistoricalUsage && this.latestHistory?.hasData === true ? this.latestHistory : undefined;
    const parts = [`$(hubot) ctx ${fillPercent}%`];

    if (history !== undefined) {
      parts.push(`5h ${Math.round(history.pct5h)}%`, `7d ${Math.round(history.pct7d)}%`);
    }

    this.item.text = parts.join('  ');
    this.item.tooltip = this.buildTooltip(fillPercent, history);
    this.item.backgroundColor =
      fillPercent >= 60
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : fillPercent >= 40
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.show();
  }

  private startHistoryTimerIfNeeded(): void {
    if (this.disposed) {
      return;
    }

    if (!vscode.workspace.getConfiguration('claudeContext').get<boolean>('showHistoricalUsage', true)) {
      this.stopHistoryTimer();
      this.latestHistory = undefined;
      return;
    }

    if (this.historyRefreshTimer !== undefined) {
      return;
    }

    this.scheduleHistoryRefresh();
    this.historyRefreshTimer = setInterval(() => this.scheduleHistoryRefresh(), HISTORY_REFRESH_MS);
  }

  private stopHistoryTimer(): void {
    if (this.historyRefreshTimer !== undefined) {
      clearInterval(this.historyRefreshTimer);
      this.historyRefreshTimer = undefined;
    }
  }

  private scheduleHistoryRefresh(): void {
    if (this.disposed) {
      return;
    }

    if (!vscode.workspace.getConfiguration('claudeContext').get<boolean>('showHistoricalUsage', true)) {
      this.latestHistory = undefined;
      this.stopHistoryTimer();
      return;
    }

    if (this.historyRefreshing !== undefined) {
      return;
    }

    this.historyRefreshing = this.historicalUsage
      .refresh(this.getHistoricalUsageBudgets())
      .then((snapshot) => {
        if (this.disposed) {
          return;
        }

        this.latestHistory = snapshot;
        this.render();
      })
      .catch(() => undefined)
      .finally(() => {
        this.historyRefreshing = undefined;
      });
  }

  private getHistoricalUsageBudgets(): HistoricalUsageBudgets {
    const config = vscode.workspace.getConfiguration('claudeContext');

    return {
      budget5h: config.get<number>('budget5h', DEFAULT_BUDGET_5H),
      budget7d: config.get<number>('budget7d', DEFAULT_BUDGET_7D)
    };
  }

  private buildTooltip(
    fillPercent: number,
    history: HistoricalUsageSnapshot | undefined
  ): vscode.MarkdownString {
    const totalTokens = this.latest?.totalTokens ?? 0;
    const effectiveWindow = this.latest?.effectiveWindow ?? this.latest?.contextWindow ?? 0;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = false;
    tooltip.appendText(
      buildTooltipText({
        fillPercent,
        totalTokens,
        effectiveWindow,
        history:
          history === undefined
            ? undefined
            : {
                pct5h: history.pct5h,
                pct7d: history.pct7d,
                byModel: getModelUsageRows(history)
              }
      })
    );
    return tooltip;
  }
}

function getModelUsageRows(
  history: HistoricalUsageSnapshot
): readonly { readonly model: string; readonly tokens7d: number }[] {
  return Array.from(history.byModel.entries())
    .map(([model, usage]) => ({
      model,
      tokens7d: usage.tokens7d
    }))
    .filter((row) => row.tokens7d > 0)
    .sort((a, b) => b.tokens7d - a.tokens7d || a.model.localeCompare(b.model));
}
