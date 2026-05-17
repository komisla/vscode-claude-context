import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTooltipText, formatCompactTokens } from '../statusBarFormatting';

test('formatCompactTokens keeps compact units readable at large values', () => {
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(1_500), '1.5k');
  assert.equal(formatCompactTokens(99_999_999), '100m');
});

test('buildTooltipText includes context, history and call to action', () => {
  const text = buildTooltipText({
    fillPercent: 72,
    totalTokens: 99_999_999,
    effectiveWindow: 200_000,
    history: {
      pct5h: 12.4,
      pct7d: 34.6,
      byModel: [
        { model: 'claude-sonnet-4-6', tokens7d: 12_300 },
        { model: 'unknown/absent', tokens7d: 450 }
      ]
    }
  });

  assert.match(text, /Context: 72% \(100m \/ 200k tokens\)/);
  assert.match(text, /Last 5h: 12% of budget/);
  assert.match(text, /Last 7d: 35% of budget/);
  assert.match(text, /Last 7d by model:/);
  assert.match(text, /claude-sonnet-4-6\s+12\.3k tokens/);
  assert.match(text, /unknown\/absent\s+450 tokens/);
  assert.match(text, /Context high - run `\/compact` or start a new chat/);
  assert.match(text, /Token counts use GPT-tokenizer approximation\./);
  assert.match(text, /Click for breakdown and details/);
  assert.match(text, /Context: 72% \(100m \/ 200k tokens\)\n\nLast 5h: 12% of budget/);
});
