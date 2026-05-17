export interface StatusBarHistoryRow {
  readonly model: string;
  readonly tokens7d: number;
}

export interface StatusBarTooltipHistory {
  readonly pct5h: number;
  readonly pct7d: number;
  readonly byModel: readonly StatusBarHistoryRow[];
}

export interface BuildTooltipTextOptions {
  readonly fillPercent: number;
  readonly totalTokens: number;
  readonly effectiveWindow: number;
  readonly history?: StatusBarTooltipHistory;
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) {
    return '0';
  }

  const absolute = Math.abs(tokens);
  const sign = tokens < 0 ? '-' : '';

  if (absolute >= 1_000_000_000) {
    return `${sign}${formatCompactMagnitude(absolute / 1_000_000_000)}b`;
  }

  if (absolute >= 1_000_000) {
    return `${sign}${formatCompactMagnitude(absolute / 1_000_000)}m`;
  }

  if (absolute >= 1_000) {
    return `${sign}${formatCompactMagnitude(absolute / 1_000)}k`;
  }

  return `${Math.round(tokens)}`;
}

export function buildTooltipText(options: BuildTooltipTextOptions): string {
  const lines = [
    `Context: ${options.fillPercent}% (${formatCompactTokens(options.totalTokens)} / ${formatCompactTokens(
      options.effectiveWindow
    )} tokens)`
  ];

  if (options.history !== undefined) {
    lines.push(`Last 5h: ${Math.round(options.history.pct5h)}% of budget`);
    lines.push(`Last 7d: ${Math.round(options.history.pct7d)}% of budget`);

    if (options.history.byModel.length > 0) {
      lines.push('Last 7d by model:');

      for (const row of options.history.byModel) {
        lines.push(`  ${row.model}  ${formatCompactTokens(row.tokens7d)} tokens`);
      }
    }
  }

  if (options.fillPercent >= 60) {
    lines.push('Context high - run `/compact` or start a new chat');
  }

  lines.push('Token counts use GPT-tokenizer approximation.');
  lines.push('Click for breakdown and details');
  return lines.join('\n');
}

function formatCompactMagnitude(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
}
