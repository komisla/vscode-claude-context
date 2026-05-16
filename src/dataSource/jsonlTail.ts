import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContextDataSource, ContextUpdate } from '.';

export class JsonlTailDataSource implements ContextDataSource {
  private readonly emitter = new vscode.EventEmitter<ContextUpdate>();
  private latest: ContextUpdate = {
    error: 'Claude Code session not found'
  };

  public readonly onDidChange = this.emitter.event;

  public getLatest(): ContextUpdate {
    return this.latest;
  }

  public getClaudeProjectsRoot(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}
