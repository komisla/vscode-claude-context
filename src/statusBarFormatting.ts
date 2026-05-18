export interface StatusBarTooltipRateLimit {
  readonly pct5h: number;
  readonly pct7d: number;
  readonly reset5h?: string;
  readonly reset7d?: string;
}

export interface BuildTooltipTextOptions {
  readonly fillPercent: number;
  readonly totalTokens: number;
  readonly effectiveWindow: number;
  readonly contextWindow?: number;
  readonly rateLimit?: StatusBarTooltipRateLimit;
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
  const rawSuffix =
    options.contextWindow !== undefined && options.contextWindow > 0
      ? `  ·  ${Math.round((options.totalTokens / options.contextWindow) * 100)}% of ${formatCompactTokens(options.contextWindow)} total`
      : '';

  const lines = [
    `Context: ${options.fillPercent}% (${formatCompactTokens(options.totalTokens)} / ${formatCompactTokens(
      options.effectiveWindow
    )} usable tokens${rawSuffix})`
  ];

  if (options.rateLimit !== undefined) {
    lines.push(`Last 5h: ${Math.round(options.rateLimit.pct5h)}% of plan limit`);
    lines.push(`Last 7d: ${Math.round(options.rateLimit.pct7d)}% of plan limit`);
  }

  if (options.fillPercent >= 60) {
    lines.push('Context high - run `/compact` or start a new chat');
  }

  lines.push('Token counts use GPT-tokenizer approximation.');
  lines.push('Click for breakdown and details');
  return lines.join('\n\n');
}

function formatCompactMagnitude(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
}
