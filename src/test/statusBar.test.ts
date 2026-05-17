import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { StatusBarController } from '../statusBar';
import type { ContextUpdate } from '../dataSource';
import type { HistoricalUsageReader, HistoricalUsageSnapshot } from '../dataSource/historicalUsage';

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

function makeHistorySnapshot(): HistoricalUsageSnapshot {
  return {
    tokens5h: 0,
    tokens7d: 0,
    pct5h: 0,
    pct7d: 0,
    hasData: false,
    byModel: new Map()
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

test('StatusBarController applies thresholds and starts and stops the history timer', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 40,
    showHistoricalUsage: true
  });

  const historicalUsage = {
    refresh: async () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 39,
    totalTokens: 39_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  const controller = new StatusBarController(tracker.source, historicalUsage);
  const item = vscodeMock.window.statusBarItems[0];

  assert.equal(vscodeMock.window.statusBarItems.length, 1);
  assert.equal(item.visible, false);
  assert.equal(item.hideCount, 1);
  assert.equal(item.backgroundColor, undefined);
  assert.equal((controller as unknown as { historyRefreshTimer: unknown }).historyRefreshTimer, undefined);

  tracker.fire({
    fillPercent: 50,
    totalTokens: 50_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, true);
  assert.equal(item.text, '$(hubot) ctx 50%');
  assert.equal(item.backgroundColor!.id, 'statusBarItem.warningBackground');
  assert.notEqual((controller as unknown as { historyRefreshTimer: unknown }).historyRefreshTimer, undefined);

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
  assert.equal((controller as unknown as { historyRefreshTimer: unknown }).historyRefreshTimer, undefined);

  controller.dispose();
  tracker.source.dispose();
});

test('StatusBarController ignores a late history refresh after dispose', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 40,
    showHistoricalUsage: true
  });

  const pending = deferred<HistoricalUsageSnapshot>();
  const historicalUsage = {
    refresh: async () => pending.promise
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 70,
    totalTokens: 70_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  const controller = new StatusBarController(tracker.source, historicalUsage);
  const item = vscodeMock.window.statusBarItems[0];

  tracker.fire({
    fillPercent: 70,
    totalTokens: 70_000,
    contextWindow: 100_000,
    effectiveWindow: 100_000
  });

  assert.equal(item.visible, true);
  assert.equal(item.showCount, 1);
  assert.notEqual((controller as unknown as { historyRefreshTimer: unknown }).historyRefreshTimer, undefined);

  controller.dispose();
  pending.resolve({
    tokens5h: 1,
    tokens7d: 1,
    pct5h: 1,
    pct7d: 1,
    hasData: true,
    byModel: new Map()
  });
  await flush();

  assert.equal(item.showCount, 1);
  assert.equal(item.hideCount, 1);
  assert.equal((controller as unknown as { historyRefreshTimer: unknown }).historyRefreshTimer, undefined);

  tracker.source.dispose();
});
