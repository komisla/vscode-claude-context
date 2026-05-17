import * as vscode from 'vscode';
import { JsonlTailDataSource } from './jsonlTail';

export interface ContextUpdate {
  readonly fillPercent?: number;
  readonly totalTokens?: number;
  readonly contextWindow?: number;
  readonly effectiveWindow?: number;
  readonly model?: string;
  readonly sessionPath?: string;
  readonly error?: string;
}

export interface ContextDataSource extends vscode.Disposable {
  readonly onDidChange: vscode.Event<ContextUpdate>;
  getLatest(): ContextUpdate;
  whenIdle(): Promise<void>;
}

export function createDataSource(): ContextDataSource {
  return new JsonlTailDataSource(vscode);
}
