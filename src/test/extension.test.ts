import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';

function mockVscode(): any {
  return vscode as any;
}

test('activate wires the command, status bar and panel into the extension context', () => {
  const vscodeMock = mockVscode();
  vscodeMock.resetMockState();
  vscodeMock.setWorkspaceConfiguration('claudeContext', {
    hideBelow: 40,
    showHistoricalUsage: true
  });

  const context = {
    subscriptions: [],
    extensionUri: vscode.Uri.parse('file:///extension')
  } as any;

  activate(context);

  assert.ok(context.subscriptions.length > 0);
  assert.equal(
    vscodeMock.commands.registeredCommands.some((entry: { id: string }) => entry.id === 'claudeContext.openPanel'),
    true
  );

  deactivate();

  for (const disposable of context.subscriptions.slice().reverse()) {
    disposable.dispose();
  }
});
