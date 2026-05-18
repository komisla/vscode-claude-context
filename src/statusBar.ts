import * as vscode from 'vscode';
import { clearInterval, setInterval } from 'timers';
import type { ContextDataSource, ContextUpdate } from './dataSource';
import { RATE_LIMIT_REFRESH_MS, RateLimitReader, type RateLimitSnapshot } from './dataSource/rateLimit';
import { buildTooltipText } from './statusBarFormatting';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly rateLimit: RateLimitReader;
  private disposed = false;
  private rateLimitRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private rateLimitRefreshing: Promise<void> | undefined;
  private pendingDispose: Promise<void> | undefined;
  private latest: ContextUpdate | undefined;
  private latestRateLimit: RateLimitSnapshot | undefined;

  public constructor(source: ContextDataSource, rateLimit: RateLimitReader) {
    this.rateLimit = rateLimit;
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

          if (event.affectsConfiguration('claudeContext.showHistoricalUsage')) {
            this.scheduleRateLimitRefresh();
          }
        }
      })
    );

    this.render();
  }

  public dispose(): void {
    this.disposed = true;
    this.stopRateLimitTimer();

    if (this.rateLimitRefreshing !== undefined) {
      this.pendingDispose = this.rateLimitRefreshing.catch(() => undefined);
    }

    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  public async whenIdle(): Promise<void> {
    const pending = [this.rateLimitRefreshing, this.pendingDispose].filter(
      (work): work is Promise<void> => work !== undefined
    );

    if (pending.length > 0) {
      await Promise.all(pending).catch(() => undefined);
    }
  }

  private render(): void {
    if (this.disposed) {
      return;
    }

    const config = vscode.workspace.getConfiguration('claudeContext');
    const hideBelow = config.get<number>('hideBelow', 0);
    const showHistoricalUsage = config.get<boolean>('showHistoricalUsage', false);

    if (this.latest?.fillPercent === undefined) {
      this.stopRateLimitTimer();
      this.item.text = '$(hubot) ctx idle';
      this.item.tooltip = 'Claude Context Monitor: waiting for an active Claude Code session';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const fillPercent = Math.round(this.latest.fillPercent);

    if (hideBelow > 0 && fillPercent < hideBelow) {
      this.stopRateLimitTimer();
      this.item.hide();
      return;
    }

    this.startRateLimitTimerIfNeeded();

    const rateLimit = showHistoricalUsage ? this.latestRateLimit : undefined;
    const parts = [`$(hubot) ctx ${fillPercent}%`];

    if (rateLimit !== undefined) {
      parts.push(`5h ${Math.round(rateLimit.pct5h)}%`, `7d ${Math.round(rateLimit.pct7d)}%`);
    }

    this.item.text = parts.join('  ');
    this.item.tooltip = this.buildTooltip(fillPercent, rateLimit);
    this.item.backgroundColor =
      fillPercent >= 60
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : fillPercent >= 40
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.show();
  }

  private startRateLimitTimerIfNeeded(): void {
    if (this.disposed) {
      return;
    }

    if (!vscode.workspace.getConfiguration('claudeContext').get<boolean>('showHistoricalUsage', false)) {
      this.stopRateLimitTimer();
      this.latestRateLimit = undefined;
      return;
    }

    if (this.rateLimitRefreshTimer !== undefined) {
      return;
    }

    this.scheduleRateLimitRefresh();
    this.rateLimitRefreshTimer = setInterval(() => this.scheduleRateLimitRefresh(), RATE_LIMIT_REFRESH_MS);
  }

  private stopRateLimitTimer(): void {
    if (this.rateLimitRefreshTimer !== undefined) {
      clearInterval(this.rateLimitRefreshTimer);
      this.rateLimitRefreshTimer = undefined;
    }
  }

  private scheduleRateLimitRefresh(): void {
    if (this.disposed) {
      return;
    }

    if (!vscode.workspace.getConfiguration('claudeContext').get<boolean>('showHistoricalUsage', false)) {
      this.latestRateLimit = undefined;
      this.stopRateLimitTimer();
      return;
    }

    if (this.rateLimitRefreshing !== undefined) {
      return;
    }

    this.rateLimitRefreshing = this.rateLimit
      .refresh()
      .then((snapshot) => {
        if (this.disposed) {
          return;
        }

        this.latestRateLimit = snapshot;
        this.render();
      })
      .catch(() => undefined)
      .finally(() => {
        this.rateLimitRefreshing = undefined;
      });
  }

  private buildTooltip(
    fillPercent: number,
    rateLimit: RateLimitSnapshot | undefined
  ): vscode.MarkdownString {
    const totalTokens = this.latest?.totalTokens ?? 0;
    const contextWindow = this.latest?.contextWindow;
    const effectiveWindow = this.latest?.effectiveWindow ?? contextWindow ?? 0;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = false;
    tooltip.appendText(
      buildTooltipText({
        fillPercent,
        totalTokens,
        effectiveWindow,
        contextWindow,
        rateLimit:
          rateLimit === undefined
            ? undefined
            : {
                pct5h: rateLimit.pct5h,
                pct7d: rateLimit.pct7d,
                reset5h: rateLimit.reset5h,
                reset7d: rateLimit.reset7d
              }
      })
    );
    return tooltip;
  }
}
