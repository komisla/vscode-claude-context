import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { StatusBarController } from '../statusBar';
import type { ContextUpdate } from '../dataSource';
import type { RateLimitReader, RateLimitSnapshot } from '../dataSource/rateLimit';

interface VscodeMock {
  readonly resetMockState: () => void;
  readonly setWorkspaceConfiguration: (
    section: string,
    values: Record<string, unknown>
  ) => void;
  readonly window: {
    readonly statusBarItems: Array<{
      visible: boolean;
      hideCount: number;
      showCount: number;
      text: string;
      backgroundColor: { readonly id: string } | undefined;
    }>;
  };
}

function createSource(initial: ContextUpdate) {
  const emitter = new vscode.EventEmitter<ContextUpdate>();
  let latest = initial;

  return {
    source: {
      onDidChange: emitter.event,
      getLatest: () => latest,
      dispose: () => emitter.dispose(),
      whenIdle: async () => undefined
    },
    setLatest(next: ContextUpdate) {
      latest = next;
    },
    fire(next: ContextUpdate) {
      latest = next;
      emitter.fire(next);
    }
  };
}

function makeRateLimitSnapshot(): RateLimitSnapshot {
  return {
    pct5h: 0,
    pct7d: 0
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('StatusBarController applies thresholds and starts and stops the rate-limit timer', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 40,
    showHistoricalUsage: true
  });

  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 39,
    totalTokens: 39_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  const controller = new StatusBarController(tracker.source, rateLimit);
  const item = vscodeMock.window.statusBarItems[0];

  assert.equal(vscodeMock.window.statusBarItems.length, 1);
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(hubot) ctx idle');
  assert.equal(item.backgroundColor, undefined);
  assert.equal((controller as unknown as { rateLimitRefreshTimer: unknown }).rateLimitRefreshTimer, undefined);

  tracker.fire({
    fillPercent: 39,
    totalTokens: 39_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, false);
  assert.equal(item.hideCount, 1);

  tracker.fire({
    fillPercent: 50,
    totalTokens: 50_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, true);
  assert.equal(item.text, '$(hubot) ctx 50%');
  assert.equal(item.backgroundColor!.id, 'statusBarItem.warningBackground');
  assert.notEqual((controller as unknown as { rateLimitRefreshTimer: unknown }).rateLimitRefreshTimer, undefined);

  tracker.fire({
    fillPercent: 65,
    totalTokens: 65_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.text, '$(hubot) ctx 65%');
  assert.equal(item.backgroundColor!.id, 'statusBarItem.errorBackground');

  tracker.fire({
    fillPercent: 10,
    totalTokens: 10_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, false);
  assert.equal(item.hideCount >= 2, true);
  assert.equal((controller as unknown as { rateLimitRefreshTimer: unknown }).rateLimitRefreshTimer, undefined);

  controller.dispose();
  tracker.source.dispose();
});

test('StatusBarController shows an idle indicator when no fillPercent is available', () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 0,
    showHistoricalUsage: false
  });

  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({ error: 'Claude Code session not found' });

  const controller = new StatusBarController(tracker.source, rateLimit);
  const item = vscodeMock.window.statusBarItems[0];

  assert.equal(item.visible, true);
  assert.equal(item.text, '$(hubot) ctx idle');
  assert.equal(item.backgroundColor, undefined);

  controller.dispose();
  tracker.source.dispose();
});

test('StatusBarController stays visible at low fillPercent when hideBelow is 0', () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 0,
    showHistoricalUsage: false
  });

  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({ error: 'Claude Code session not found' });

  const controller = new StatusBarController(tracker.source, rateLimit);
  const item = vscodeMock.window.statusBarItems[0];

  tracker.fire({
    fillPercent: 5,
    totalTokens: 5_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, true);
  assert.equal(item.text, '$(hubot) ctx 5%');
  assert.equal(item.backgroundColor, undefined);

  controller.dispose();
  tracker.source.dispose();
});

test('StatusBarController ignores a late rate-limit refresh after dispose', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 40,
    showHistoricalUsage: true
  });

  const pending = deferred<RateLimitSnapshot>();
  const rateLimit = {
    refresh: async () => pending.promise
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 70,
    totalTokens: 70_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  const controller = new StatusBarController(tracker.source, rateLimit);
  const item = vscodeMock.window.statusBarItems[0];

  tracker.fire({
    fillPercent: 70,
    totalTokens: 70_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, true);
  assert.equal(item.showCount, 2);
  assert.notEqual((controller as unknown as { rateLimitRefreshTimer: unknown }).rateLimitRefreshTimer, undefined);

  controller.dispose();
  pending.resolve({
    pct5h: 1,
    pct7d: 1
  });
  await flush();

  assert.equal(item.showCount, 2);
  assert.equal(item.hideCount, 0);
  assert.equal((controller as unknown as { rateLimitRefreshTimer: unknown }).rateLimitRefreshTimer, undefined);

  tracker.source.dispose();
});
