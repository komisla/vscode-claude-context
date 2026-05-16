import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { Buffer } from 'buffer';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { clearTimeout, setTimeout } from 'timers';
import type * as vscode from 'vscode';
import type { ContextDataSource, ContextUpdate } from '.';

const UPDATE_INTERVAL_MS = 5_000;
const CLAUDE_INTERNAL_RESERVE_TOKENS = 13_000;
const SESSION_NOT_FOUND_ERROR = 'Claude Code session not found';

interface ModelLimits {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

interface ActiveSession {
  readonly projectDir: string;
  readonly jsonlPath: string;
}

interface JsonlCandidate {
  readonly path: string;
  readonly mtimeMs: number;
}

export const MODEL_TABLE: Readonly<Record<string, ModelLimits>> = {
  'claude-sonnet-4': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-opus-4': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-haiku-4': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  unknown: { contextWindow: 200_000, maxOutputTokens: 8_192 }
};

export function slugify(cwd: string): string {
  return cwd.replace(/:/g, '-').replace(/[/\\]/g, '-');
}

export function isAssistantTurn(line: unknown): boolean {
  if (!isRecord(line) || line.isSidechain === true || !isRecord(line.message)) {
    return false;
  }

  return line.message.role === 'assistant' && line.message.usage !== undefined;
}

export function getUsageTotal(usage: unknown): number {
  if (!isRecord(usage)) {
    return 0;
  }

  return (
    numberValue(usage.input_tokens) +
    numberValue(usage.cache_read_input_tokens) +
    numberValue(usage.cache_creation_input_tokens) +
    numberValue(usage.output_tokens)
  );
}

export function getModelLimits(model: string | undefined): ModelLimits {
  const modelName = model ?? 'unknown';
  const modelKey =
    Object.keys(MODEL_TABLE).find((key) => key !== 'unknown' && modelName.startsWith(key)) ??
    'unknown';

  return MODEL_TABLE[modelKey];
}

export function calculateFillPercent(
  totalTokens: number,
  model: string | undefined
): {
  readonly fillPercent: number;
  readonly contextWindow: number;
  readonly effectiveWindow: number;
} {
  const { contextWindow, maxOutputTokens } = getModelLimits(model);
  const effectiveWindow = Math.max(
    contextWindow - maxOutputTokens - CLAUDE_INTERNAL_RESERVE_TOKENS,
    1
  );

  return {
    fillPercent: Math.min((totalTokens / effectiveWindow) * 100, 100),
    contextWindow,
    effectiveWindow
  };
}

export function parseContextUpdateFromLine(
  lineText: string,
  sessionPath: string
): ContextUpdate | undefined {
  let line: unknown;

  try {
    line = JSON.parse(lineText) as unknown;
  } catch {
    return undefined;
  }

  if (!isAssistantTurn(line) || !isRecord(line) || !isRecord(line.message)) {
    return undefined;
  }

  const usage = line.message.usage;
  const totalTokens = getUsageTotal(usage);
  const model = typeof line.message.model === 'string' ? line.message.model : 'unknown';
  const { fillPercent, contextWindow, effectiveWindow } = calculateFillPercent(totalTokens, model);

  return {
    fillPercent,
    totalTokens,
    contextWindow,
    effectiveWindow,
    model,
    sessionPath
  };
}

export class JsonlTailDataSource implements ContextDataSource {
  private readonly vscodeApi: typeof vscode;
  private readonly emitter: vscode.EventEmitter<ContextUpdate>;
  private latest: ContextUpdate = {
    error: SESSION_NOT_FOUND_ERROR
  };

  private claudeRootWatcher: fs.FSWatcher | undefined;
  private ideWatcher: fs.FSWatcher | undefined;
  private projectWatcher: fs.FSWatcher | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTickAt = 0;
  private currentProjectDir: string | undefined;
  private readonly offsets = new Map<string, number>();
  private readonly remainders = new Map<string, string>();
  private disposed = false;
  private refreshing: Promise<void> | undefined;

  public readonly onDidChange: vscode.Event<ContextUpdate>;

  public constructor(vscodeApi: typeof vscode) {
    this.vscodeApi = vscodeApi;
    this.emitter = new this.vscodeApi.EventEmitter<ContextUpdate>();
    this.onDidChange = this.emitter.event;

    this.watchClaudeRoot();
    this.watchIdeRoot();
    void this.refreshActiveSession();
  }

  public getLatest(): ContextUpdate {
    return this.latest;
  }

  public getClaudeProjectsRoot(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  public dispose(): void {
    this.disposed = true;
    this.claudeRootWatcher?.close();
    this.ideWatcher?.close();
    this.projectWatcher?.close();

    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }

    if (this.tickTimer !== undefined) {
      clearTimeout(this.tickTimer);
    }

    this.emitter.dispose();
  }

  private getClaudeRoot(): string {
    return path.join(os.homedir(), '.claude');
  }

  private getClaudeIdeRoot(): string {
    return path.join(this.getClaudeRoot(), 'ide');
  }

  private watchClaudeRoot(): void {
    const claudeRoot = this.getClaudeRoot();

    this.createWatcher(claudeRoot, () => {
      this.watchIdeRoot();
      this.scheduleRefresh(250);
    }).then((watcher) => {
      if (this.disposed) {
        watcher.close();
        return;
      }

      this.claudeRootWatcher = watcher;
    }, () => undefined);
  }

  private watchIdeRoot(): void {
    if (this.disposed || this.ideWatcher !== undefined) {
      return;
    }

    this.createWatcher(this.getClaudeIdeRoot(), () => this.scheduleRefresh(250)).then((watcher) => {
      if (this.disposed) {
        watcher.close();
        return;
      }

      this.ideWatcher = watcher;
    }, () => undefined);
  }

  private watchProjectDir(projectDir: string): void {
    if (this.currentProjectDir === projectDir && this.projectWatcher !== undefined) {
      return;
    }

    this.projectWatcher?.close();
    this.projectWatcher = undefined;
    this.currentProjectDir = projectDir;

    this.createWatcher(projectDir, (_event, filename) => {
      const changedFilename = typeof filename === 'string' ? filename : filename?.toString();

      if (changedFilename === undefined || changedFilename.endsWith('.jsonl')) {
        this.scheduleTick();
      }
    }).then((watcher) => {
      if (!this.disposed && this.currentProjectDir === projectDir) {
        this.projectWatcher = watcher;
      } else {
        watcher.close();
      }
    }, () => undefined);
  }

  private async createWatcher(
    dir: string,
    listener: (event: string, filename: string | Buffer | null) => void
  ): Promise<fs.FSWatcher> {
    await fsp.access(dir);
    return fs.watch(dir, listener);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.disposed) {
      return;
    }

    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshActiveSession();
    }, delayMs);
  }

  private scheduleTick(): void {
    if (this.disposed || this.tickTimer !== undefined) {
      return;
    }

    const elapsedMs = Date.now() - this.lastTickAt;
    const delayMs = Math.max(UPDATE_INTERVAL_MS - elapsedMs, 0);

    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      void this.refreshActiveSession();
    }, delayMs);
  }

  private async refreshActiveSession(): Promise<void> {
    if (this.refreshing !== undefined) {
      return this.refreshing;
    }

    this.refreshing = this.refreshActiveSessionCore()
      .catch(() => {
        this.emitUpdate({ error: SESSION_NOT_FOUND_ERROR });
      })
      .finally(() => {
        this.lastTickAt = Date.now();
        this.refreshing = undefined;
      });

    return this.refreshing;
  }

  private async refreshActiveSessionCore(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const activeSession = await this.findActiveSession();

    if (activeSession === undefined) {
      this.projectWatcher?.close();
      this.projectWatcher = undefined;
      this.currentProjectDir = undefined;
      this.emitUpdate({ error: SESSION_NOT_FOUND_ERROR });
      return;
    }

    this.watchProjectDir(activeSession.projectDir);
    await this.readNewBytes(activeSession.jsonlPath);
  }

  private async findActiveSession(): Promise<ActiveSession | undefined> {
    const workspaceFolders = this.vscodeApi.workspace.workspaceFolders ?? [];
    const normalizedWorkspaceFolders = workspaceFolders.map((folder) =>
      normalizeWorkspacePath(folder.uri.fsPath)
    );

    if (normalizedWorkspaceFolders.length === 0) {
      return undefined;
    }

    const locks = await this.readLockFiles();
    let bestSession: ActiveSession | undefined;
    let bestMtimeMs = -1;

    for (const lockPath of locks) {
      const lock = await this.readLock(lockPath);
      const matchedFolder = lock.workspaceFolders.find((folder) =>
        normalizedWorkspaceFolders.includes(normalizeWorkspacePath(folder))
      );

      if (matchedFolder === undefined) {
        continue;
      }

      const projectDir = path.join(this.getClaudeProjectsRoot(), slugify(matchedFolder));
      const jsonl = await this.findNewestJsonl(projectDir);

      if (jsonl !== undefined && jsonl.mtimeMs > bestMtimeMs) {
        bestMtimeMs = jsonl.mtimeMs;
        bestSession = {
          projectDir,
          jsonlPath: jsonl.path
        };
      }
    }

    return bestSession;
  }

  private async readLockFiles(): Promise<string[]> {
    let entries: fs.Dirent[];

    try {
      entries = await fsp.readdir(this.getClaudeIdeRoot(), { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.lock'))
      .map((entry) => path.join(this.getClaudeIdeRoot(), entry.name));
  }

  private async readLock(lockPath: string): Promise<{ readonly workspaceFolders: readonly string[] }> {
    let raw: string;

    try {
      raw = await fsp.readFile(lockPath, 'utf8');
    } catch {
      return { workspaceFolders: [] };
    }

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (!isRecord(parsed) || !Array.isArray(parsed.workspaceFolders)) {
        return { workspaceFolders: [] };
      }

      return {
        workspaceFolders: parsed.workspaceFolders.filter(
          (folder): folder is string => typeof folder === 'string'
        )
      };
    } catch {
      return { workspaceFolders: [] };
    }
  }

  private async findNewestJsonl(projectDir: string): Promise<JsonlCandidate | undefined> {
    let entries: fs.Dirent[];

    try {
      entries = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    let newest: JsonlCandidate | undefined;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const filePath = path.join(projectDir, entry.name);
      let stats: fs.Stats;

      try {
        stats = await fsp.stat(filePath);
      } catch {
        continue;
      }

      if (newest === undefined || stats.mtimeMs > newest.mtimeMs) {
        newest = {
          path: filePath,
          mtimeMs: stats.mtimeMs
        };
      }
    }

    return newest;
  }

  private async readNewBytes(filePath: string): Promise<void> {
    let stats: fs.Stats;

    try {
      stats = await fsp.stat(filePath);
    } catch {
      this.emitUpdate({ error: SESSION_NOT_FOUND_ERROR });
      return;
    }

    const previousOffset = this.offsets.get(filePath) ?? 0;
    const offset = stats.size < previousOffset ? 0 : previousOffset;

    if (stats.size === offset) {
      return;
    }

    const handle = await fsp.open(filePath, 'r');

    try {
      const length = stats.size - offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);

      this.offsets.set(filePath, offset + bytesRead);
      this.consumeChunk(filePath, buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  }

  private consumeChunk(filePath: string, chunk: string): void {
    const combined = `${this.remainders.get(filePath) ?? ''}${chunk}`;
    const complete = combined.endsWith('\n');
    const lines = combined.split(/\r?\n/);
    const completeLines = complete ? lines : lines.slice(0, -1);
    const remainder = complete ? '' : lines.at(-1) ?? '';
    let latestUpdate: ContextUpdate | undefined;

    this.remainders.set(filePath, remainder);

    for (const line of completeLines) {
      if (line.trim() === '') {
        continue;
      }

      latestUpdate = parseContextUpdateFromLine(line, filePath) ?? latestUpdate;
    }

    if (latestUpdate !== undefined) {
      this.emitUpdate(latestUpdate);
    }
  }

  private emitUpdate(update: ContextUpdate): void {
    if (this.disposed) {
      return;
    }

    this.latest = update;
    this.emitter.fire(update);
  }
}

function normalizeWorkspacePath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
