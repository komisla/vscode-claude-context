import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFillPercent, getModelLimits } from '../dataSource/jsonlTail';

test('fill percent uses effective context window', () => {
  const sonnet = calculateFillPercent(77_500, 'claude-sonnet-4-6:thinking');
  const opus = calculateFillPercent(77_500, 'claude-opus-4-7');

  assert.equal(sonnet.contextWindow, 200_000);
  assert.equal(sonnet.effectiveWindow, 178_808);
  assert.equal(sonnet.fillPercent, (77_500 / 178_808) * 100);
  // Opus has higher maxOutputTokens, so a smaller effectiveWindow than Sonnet
  assert.equal(opus.effectiveWindow, 155_000);
  assert.notEqual(sonnet.effectiveWindow, opus.effectiveWindow);
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

test('unknown opus models fall back to opus family limits', () => {
  const limits = getModelLimits('claude-opus-9-9');

  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 128_000);
});

test('unknown sonnet models fall back to sonnet family limits', () => {
  const limits = getModelLimits('claude-sonnet-5');

  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 64_000);
});

test('unknown haiku models fall back to haiku family limits', () => {
  const limits = getModelLimits('claude-haiku-6');

  assert.equal(limits.contextWindow, 200_000);
  assert.equal(limits.maxOutputTokens, 8_192);
});

test('opus 4.7 uses the current Anthropic limits', () => {
  const limits = getModelLimits('claude-opus-4-7:thinking');
  const { effectiveWindow, fillPercent } = calculateFillPercent(155_000, 'claude-opus-4-7:thinking');

  assert.equal(limits.contextWindow, 200_000);
  assert.equal(limits.maxOutputTokens, 32_000);
  assert.equal(effectiveWindow, 155_000);
  assert.equal(fillPercent, 100);
});

test('sonnet 4.6 uses the current Anthropic limits', () => {
  const limits = getModelLimits('claude-sonnet-4-6');

  assert.equal(limits.contextWindow, 200_000);
  assert.equal(limits.maxOutputTokens, 8_192);
});

test('unknown non-opus models still use default limits', () => {
  const limits = getModelLimits('claude-unknown-99-9');

  assert.equal(limits.contextWindow, 200_000);
  assert.equal(limits.maxOutputTokens, 8_192);
});

test('unknown models emit a drift warning once with chosen contextWindow', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    const first = getModelLimits('claude-unknown-99-10');
    const second = getModelLimits('claude-unknown-99-10');

    assert.equal(first.contextWindow, 200_000);
    assert.equal(second.maxOutputTokens, 8_192);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Unknown Claude model "claude-unknown-99-10"/);
    assert.match(warnings[0], /contextWindow=200000/);
  } finally {
    console.warn = originalWarn;
  }
});

test('unknown sonnet drift warning reports the 1M fallback window', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    getModelLimits('claude-sonnet-5-drift');

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Unknown Claude model "claude-sonnet-5-drift"/);
    assert.match(warnings[0], /contextWindow=1000000/);
  } finally {
    console.warn = originalWarn;
  }
});
