import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFillPercent } from '../dataSource/jsonlTail';

test('fill percent uses effective context window', () => {
  const { fillPercent, contextWindow } = calculateFillPercent(89_404, 'claude-sonnet-4-20250514');

  assert.equal(contextWindow, 200_000);
  assert.equal(fillPercent, 50);
});

test('fill percent caps at 100', () => {
  const { fillPercent } = calculateFillPercent(500_000, 'claude-haiku-4-20250514');

  assert.equal(fillPercent, 100);
});

test('fill percent falls back for unknown models', () => {
  const { fillPercent, contextWindow, effectiveWindow } = calculateFillPercent(
    178_808,
    'unexpected-model'
  );

  assert.equal(contextWindow, 200_000);
  assert.equal(fillPercent, Math.min((178_808 / effectiveWindow) * 100, 100));
});
