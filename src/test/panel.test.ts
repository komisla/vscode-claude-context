import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { BreakdownPanel } from '../webview/panel';
import type { ContextDataSource, ContextUpdate } from '../dataSource';
import type { HistoricalUsageReader, HistoricalUsageSnapshot } from '../dataSource/historicalUsage';
import type { RateLimitReader, RateLimitSnapshot } from '../dataSource/rateLimit';

interface VscodeMock {
  readonly resetMockState: () => void;
  readonly setWorkspaceConfiguration: (
    section: string,
    values: Record<string, unknown>
  ) => void;
  readonly setExtension: (extensionId: string, extension: unknown) => void;
  readonly env: {
    openExternalResult: boolean;
    readonly openExternalCalls: { readonly toString: () => string }[];
  };
  readonly window: {
    readonly webviewPanels: Array<{
      readonly postedMessages: Array<{ readonly type: string; readonly payload?: unknown }>;
      readonly webview: {
        receiveMessage(message: unknown): void;
      };
      dispose(): void;
    }>;
    readonly informationMessages: string[];
  };
}

const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';
const fakeClaudeCodeExtension = { id: CLAUDE_CODE_EXTENSION_ID };

function createSource(initial: ContextUpdate) {
  const emitter = new vscode.EventEmitter<ContextUpdate>();
  let latest = initial;

  return {
    source: {
      onDidChange: emitter.event,
      getLatest: () => latest,
      dispose: () => emitter.dispose()
    } as ContextDataSource,
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
    hasData: true,
    byModel: new Map()
  };
}

function makeRateLimitSnapshot(pct5h = 20, pct7d = 30): RateLimitSnapshot {
  return {
    pct5h,
    pct7d
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for panel state');
    }

    await flush();
  }
}

test('BreakdownPanel throttles historical usage refreshes', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const originalDateNow = Date.now;
  let currentTime = Date.parse('2026-05-16T12:00:00Z');
  Date.now = () => currentTime;

  let refreshCalls = 0;
  const historicalUsage = {
    refresh: async () => {
      refreshCalls += 1;
      return makeHistorySnapshot();
    },
    calculateSnapshot: () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 35
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);

  try {
    panel.open(tracker.source);
    await flush();

    assert.equal(refreshCalls, 1);

    tracker.fire({
      fillPercent: 55
    });
    await flush();

    assert.equal(refreshCalls, 1);

    currentTime += 31_000;
    tracker.fire({
      fillPercent: 65
    });
    await waitFor(() => refreshCalls === 2);

    assert.equal(refreshCalls, 2);
  } finally {
    Date.now = originalDateNow;
    tracker.source.dispose();
    panel.dispose();
  }
});

test('BreakdownPanel recalculates cached historical usage snapshots', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const originalDateNow = Date.now;
  let currentTime = Date.parse('2026-05-16T12:00:00Z');
  Date.now = () => currentTime;

  let refreshCalls = 0;
  const calculateCalls: number[] = [];
  const historicalUsage = {
    refresh: async () => {
      refreshCalls += 1;
      return {
        ...makeHistorySnapshot(),
        tokens7d: 100
      };
    },
    calculateSnapshot: (nowMs: number) => {
      calculateCalls.push(nowMs);
      return {
        ...makeHistorySnapshot(),
        tokens7d: 42
      };
    }
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 35
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  const mockPanel = vscodeMock.window.webviewPanels[0];

  try {
    await waitFor(() => refreshCalls === 1 && mockPanel.postedMessages.length >= 2);

    currentTime += 10_000;
    const expectedNow = currentTime;
    tracker.fire({
      fillPercent: 55
    });

    await waitFor(() => calculateCalls.length === 1 && mockPanel.postedMessages.length >= 4);

    assert.equal(refreshCalls, 1);
    assert.deepEqual(calculateCalls, [expectedNow]);

    const lastMessage = mockPanel.postedMessages.at(-1) as {
      readonly payload: { readonly history?: { readonly tokens7d: number } };
    };
    assert.equal(lastMessage.payload.history?.tokens7d, 42);
  } finally {
    Date.now = originalDateNow;
    tracker.source.dispose();
    panel.dispose();
  }
});

test('BreakdownPanel reuses cached history during rapid JSONL changes', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const originalDateNow = Date.now;
  let currentTime = Date.parse('2026-05-16T12:00:00Z');
  Date.now = () => currentTime;

  let refreshCalls = 0;
  const historicalUsage = {
    refresh: async () => {
      refreshCalls += 1;
      return makeHistorySnapshot();
    },
    calculateSnapshot: () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 35
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);

  try {
    panel.open(tracker.source);
    await waitFor(() => refreshCalls === 1);

    for (const fillPercent of [36, 37, 38, 39, 40]) {
      currentTime += 2_000;
      tracker.fire({ fillPercent });
      await flush();
    }

    assert.equal(refreshCalls, 1);

    currentTime += 21_000;
    tracker.fire({
      fillPercent: 41
    });
    await waitFor(() => refreshCalls === 2);

    assert.equal(refreshCalls, 2);
  } finally {
    Date.now = originalDateNow;
    tracker.source.dispose();
    panel.dispose();
  }
});

test('BreakdownPanel retries historical usage refreshes after failures', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  let refreshCalls = 0;
  const historicalUsage = {
    refresh: async () => {
      refreshCalls += 1;

      if (refreshCalls === 1) {
        throw new Error('temporary history failure');
      }

      return makeHistorySnapshot();
    }
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 35
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);

  try {
    panel.open(tracker.source);
    await waitFor(() => refreshCalls === 1);

    assert.equal(refreshCalls, 1);

    tracker.fire({
      fillPercent: 35
    });
    await waitFor(() => refreshCalls === 2);

    assert.equal(refreshCalls, 2);
  } finally {
    tracker.source.dispose();
    panel.dispose();
  }
});

test('BreakdownPanel posts context before usage snapshots settle', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const pendingHistory = deferred<HistoricalUsageSnapshot | undefined>();
  const pendingRateLimit = deferred<RateLimitSnapshot | undefined>();
  const historicalUsage = {
    refresh: async () => pendingHistory.promise
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => pendingRateLimit.promise
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  const mockPanel = vscodeMock.window.webviewPanels[0];

  try {
    await waitFor(() => mockPanel.postedMessages.length === 1);

    const firstMessage = mockPanel.postedMessages[0] as {
      readonly type: string;
      readonly payload: { readonly breakdown?: unknown; readonly rateLimit?: unknown; readonly history?: unknown };
    };
    assert.equal(firstMessage.type, 'contextSnapshot');
    assert.notEqual(firstMessage.payload.breakdown, undefined);
    assert.equal(firstMessage.payload.rateLimit, undefined);
    assert.equal(firstMessage.payload.history, undefined);

    pendingRateLimit.resolve(makeRateLimitSnapshot());
    pendingHistory.resolve(makeHistorySnapshot());

    await waitFor(() => mockPanel.postedMessages.length === 2);

    const secondMessage = mockPanel.postedMessages[1] as {
      readonly payload: {
        readonly rateLimit?: { readonly pct5h: number; readonly pct7d: number };
        readonly history?: { readonly hasData: boolean };
      };
    };
    assert.equal(secondMessage.payload.rateLimit?.pct5h, 20);
    assert.equal(secondMessage.payload.rateLimit?.pct7d, 30);
    assert.equal(secondMessage.payload.history?.hasData, true);
  } finally {
    tracker.source.dispose();
    panel.dispose();
  }
});

test('BreakdownPanel ignores stale usage snapshots after a newer context post', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const firstRateLimit = deferred<RateLimitSnapshot | undefined>();
  const secondRateLimit = deferred<RateLimitSnapshot | undefined>();
  let rateLimitCalls = 0;
  const historicalUsage = {
    refresh: async () => makeHistorySnapshot(),
    calculateSnapshot: () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => {
      rateLimitCalls += 1;
      return rateLimitCalls === 1 ? firstRateLimit.promise : secondRateLimit.promise;
    }
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  const mockPanel = vscodeMock.window.webviewPanels[0];

  try {
    await waitFor(() => mockPanel.postedMessages.length === 1 && rateLimitCalls === 1);

    tracker.fire({
      fillPercent: 65
    });

    await waitFor(() => mockPanel.postedMessages.length === 2 && rateLimitCalls === 2);

    firstRateLimit.resolve(makeRateLimitSnapshot(20, 30));
    await flush();
    assert.equal(mockPanel.postedMessages.length, 2);

    secondRateLimit.resolve(makeRateLimitSnapshot(70, 80));
    await waitFor(() => mockPanel.postedMessages.length === 3);

    const lastMessage = mockPanel.postedMessages[2] as {
      readonly payload: { readonly rateLimit?: { readonly pct5h: number; readonly pct7d: number } };
    };
    assert.equal(lastMessage.payload.rateLimit?.pct5h, 70);
    assert.equal(lastMessage.payload.rateLimit?.pct7d, 80);
  } finally {
    tracker.source.dispose();
    panel.dispose();
  }
});

test('BreakdownPanel tears down subscriptions when the panel closes', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const historicalUsage = {
    refresh: async () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  assert.equal(vscodeMock.window.webviewPanels.length, 1);
  const mockPanel = vscodeMock.window.webviewPanels[0];

  await waitFor(() => mockPanel.postedMessages.length >= 1);
  const postedBeforeDispose = mockPanel.postedMessages.length;

  mockPanel.dispose();
  tracker.fire({
    fillPercent: 75
  });
  await flush();

  assert.equal(mockPanel.postedMessages.length, postedBeforeDispose);

  tracker.source.dispose();
  panel.dispose();
});

test('BreakdownPanel falls back when openExternal is unavailable', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });
  vscodeMock.setExtension(CLAUDE_CODE_EXTENSION_ID, fakeClaudeCodeExtension);
  vscodeMock.env.openExternalResult = false;

  const historicalUsage = {
    refresh: async () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  assert.equal(vscodeMock.window.webviewPanels.length, 1);
  const mockPanel = vscodeMock.window.webviewPanels[0];

  await flush();
  mockPanel.webview.receiveMessage({ type: 'startNewChat' });
  await flush();

  assert.equal(vscodeMock.env.openExternalCalls.length, 1);
  assert.equal(vscodeMock.env.openExternalCalls[0].toString(), 'vscode://anthropic.claude-code/new-session');
  assert.equal(vscodeMock.window.informationMessages.length, 1);
  assert.match(
    vscodeMock.window.informationMessages[0],
    /Start a new Claude Code chat from the Claude Code view, or run \/clear in the terminal\./
  );
  const lastMessage = mockPanel.postedMessages.at(-1) as
    | { readonly type: 'newChatUnavailable' }
    | undefined;
  assert.notEqual(lastMessage, undefined);
  assert.equal(lastMessage!.type, 'newChatUnavailable');

  tracker.source.dispose();
  panel.dispose();
});

test('BreakdownPanel skips openExternal when Claude Code extension is missing', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });

  const historicalUsage = {
    refresh: async () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  assert.equal(vscodeMock.window.webviewPanels.length, 1);
  const mockPanel = vscodeMock.window.webviewPanels[0];

  await flush();
  mockPanel.webview.receiveMessage({ type: 'startNewChat' });
  await flush();

  assert.equal(vscodeMock.env.openExternalCalls.length, 0);
  assert.equal(vscodeMock.window.informationMessages.length, 1);
  assert.match(
    vscodeMock.window.informationMessages[0],
    /Claude Code extension not found\./
  );

  const lastMessage = mockPanel.postedMessages.at(-1) as
    | { readonly type: 'newChatUnavailable' }
    | undefined;
  assert.notEqual(lastMessage, undefined);
  assert.equal(lastMessage!.type, 'newChatUnavailable');

  tracker.source.dispose();
  panel.dispose();
});

test('BreakdownPanel opens new chat URI when Claude Code extension is installed', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    showHistoricalUsage: true
  });
  vscodeMock.setExtension(CLAUDE_CODE_EXTENSION_ID, fakeClaudeCodeExtension);

  const historicalUsage = {
    refresh: async () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  assert.equal(vscodeMock.window.webviewPanels.length, 1);
  const mockPanel = vscodeMock.window.webviewPanels[0];

  await flush();
  mockPanel.webview.receiveMessage({ type: 'startNewChat' });
  await flush();

  assert.equal(vscodeMock.env.openExternalCalls.length, 1);
  assert.equal(
    vscodeMock.env.openExternalCalls[0].toString(),
    'vscode://anthropic.claude-code/new-session'
  );
  assert.equal(vscodeMock.window.informationMessages.length, 0);

  const lastMessage = mockPanel.postedMessages.at(-1) as
    | { readonly type: 'commandResult'; readonly payload: { readonly message: string } }
    | undefined;
  assert.notEqual(lastMessage, undefined);
  assert.equal(lastMessage!.type, 'commandResult');
  assert.equal(lastMessage!.payload.message, 'Opening new Claude Code chat');

  tracker.source.dispose();
  panel.dispose();
});

test('BreakdownPanel injects a hex nonce into the webview HTML', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();

  const historicalUsage = {
    refresh: async () => makeHistorySnapshot()
  } as unknown as HistoricalUsageReader;
  const rateLimit = {
    refresh: async () => makeRateLimitSnapshot()
  } as unknown as RateLimitReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage, rateLimit);
  panel.open(tracker.source);

  assert.equal(vscodeMock.window.webviewPanels.length, 1);
  const mockPanel = vscodeMock.window.webviewPanels[0] as unknown as {
    readonly webview: { readonly html: string };
  };

  const scriptNonce = mockPanel.webview.html.match(/<script nonce="([0-9a-f]{32})">/);
  const cspNonce = mockPanel.webview.html.match(/script-src 'nonce-([0-9a-f]{32})'/);

  assert.notEqual(scriptNonce, null);
  assert.notEqual(cspNonce, null);
  assert.equal(scriptNonce?.[1], cspNonce?.[1]);

  tracker.source.dispose();
  panel.dispose();
});
