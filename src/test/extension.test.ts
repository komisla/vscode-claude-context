import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { HistoricalUsageReader, type HistoricalUsageSnapshot } from '../dataSource/historicalUsage';

interface VscodeMock {
  readonly resetMockState: () => void;
  readonly setWorkspaceConfiguration: (
    section: string,
    values: Record<string, unknown>
  ) => void;
  readonly commands: {
    readonly registeredCommands: readonly { readonly id: string }[];
  };
}

function makeHistorySnapshot(): HistoricalUsageSnapshot {
  return {
    tokens5h: 0,
    tokens7d: 0,
    hasData: false,
    byModel: new Map()
  };
}

test('activate wires the command, status bar and panel into the extension context', async () => {
  const vscodeMock = vscode as unknown as VscodeMock;
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 40,
    showHistoricalUsage: true
  });
  const originalRefresh = HistoricalUsageReader.prototype.refresh;
  let historyRefreshCalls = 0;
  HistoricalUsageReader.prototype.refresh = async () => {
    historyRefreshCalls += 1;
    return makeHistorySnapshot();
  };

  const context = {
    subscriptions: [],
    extensionUri: vscode.Uri.parse('file:///extension')
  } as unknown as Parameters<typeof activate>[0];

  try {
    activate(context);

    assert.ok(context.subscriptions.length > 0);
    assert.equal(
      vscodeMock.commands.registeredCommands.some((entry: { id: string }) => entry.id === 'claudeContext.openPanel'),
      true
    );
    assert.equal(historyRefreshCalls, 1);
  } finally {
    HistoricalUsageReader.prototype.refresh = originalRefresh;
    await deactivate();

    for (const disposable of context.subscriptions.slice().reverse()) {
      disposable.dispose();
    }
  }
});
