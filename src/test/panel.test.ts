import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { BreakdownPanel } from '../webview/panel';
import type { ContextDataSource, ContextUpdate } from '../dataSource';
import type { HistoricalUsageReader, HistoricalUsageSnapshot } from '../dataSource/historicalUsage';

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

function makeHistorySnapshot(pct5h: number, pct7d: number): HistoricalUsageSnapshot {
  return {
    tokens5h: 0,
    tokens7d: 0,
    pct5h,
    pct7d,
    hasData: true,
    byModel: new Map()
  };
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
      return makeHistorySnapshot(20, 30);
    }
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 35
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);

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
    await flush();

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

      return makeHistorySnapshot(20, 30);
    }
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 35
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);

  try {
    panel.open(tracker.source);
    await flush();

    assert.equal(refreshCalls, 1);

    tracker.fire({
      fillPercent: 35
    });
    await flush();

    assert.equal(refreshCalls, 2);
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
    refresh: async () => makeHistorySnapshot(0, 0)
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);
  panel.open(tracker.source);

  assert.equal(vscodeMock.window.webviewPanels.length, 1);
  const mockPanel = vscodeMock.window.webviewPanels[0];

  await waitFor(() => mockPanel.postedMessages.length === 1);
  assert.equal(mockPanel.postedMessages.length, 1);

  mockPanel.dispose();
  tracker.fire({
    fillPercent: 75
  });
  await flush();

  assert.equal(mockPanel.postedMessages.length, 1);

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
    refresh: async () => makeHistorySnapshot(0, 0)
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);
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
    refresh: async () => makeHistorySnapshot(0, 0)
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);
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
    refresh: async () => makeHistorySnapshot(0, 0)
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);
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
    refresh: async () => makeHistorySnapshot(0, 0)
  } as unknown as HistoricalUsageReader;

  const tracker = createSource({
    fillPercent: 45
  });

  const panel = new BreakdownPanel(vscode.Uri.parse('file:///extension'), historicalUsage);
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
