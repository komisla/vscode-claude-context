import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { Buffer } from 'buffer';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'timers';
import type * as vscode from 'vscode';
import type { ContextDataSource, ContextUpdate } from '.';

const UPDATE_INTERVAL_MS = 5_000;
const INITIAL_TAIL_READ_BYTES = 16 * 1_024;
const CLAUDE_INTERNAL_RESERVE_TOKENS = 13_000;
const WATCHER_ERROR_RETRY_MS = 30_000;
const CLAUDE_ROOT_WATCHER_ERROR_RETRY_MS = 60_000;
const STALE_LOCK_TTL_MS = 10 * 60 * 1000;
export const SESSION_NOT_FOUND_ERROR = 'Claude Code session not found';
const USAGE_TOKEN_FIELDS = [
  'input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'output_tokens'
] as const;

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

interface ResolvedLockSession {
  readonly lockPath: string;
  readonly projectDir: string;
  readonly jsonlPath: string;
  readonly lockMtimeMs: number;
  readonly jsonlMtimeMs: number;
}

interface CachedLockFile {
  readonly mtimeMs: number;
  readonly workspaceFolders: string[];
}

interface CachedIdeDirectory {
  readonly mtimeMs: number;
  readonly lockPaths: string[];
}

const DEFAULT_MODEL_LIMITS: ModelLimits = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192
};

const warnedUnknownModels = new Set<string>();
const warnedInvalidUsageSessionPaths = new Set<string>();

// Context windows verified empirically via Claude Code Stop hook context_window_percentage
// field (anthropics/claude-code#11008). Claude 4.x models use 200K despite some API docs
// listing higher maximums — the effective in-session window is 200K.
export const MODEL_TABLE: Readonly<Record<string, ModelLimits>> = {
  'claude-opus-4-5': { contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-opus-4-6': { contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-opus-4-7': { contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4-5': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-sonnet-4-6': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-sonnet-4-7': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-haiku-4-5': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-opus-4': { contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4': { contextWindow: 200_000, maxOutputTokens: 8_192 },
  'claude-haiku-4': { contextWindow: 200_000, maxOutputTokens: 8_192 }
};

export function slugify(cwd: string): string {
  // Claude Code stores per-project session JSONLs under ~/.claude/projects/<slug>/.
  // The slug is derived from the workspace cwd by replacing path separators, drive-letter
  // colons, AND whitespace with '-' — matching Claude Code's own on-disk naming.
  return cwd.replace(/:/g, '-').replace(/[/\\]/g, '-').replace(/\s+/g, '-');
}

export function isAssistantTurn(line: unknown): boolean {
  if (!isRecord(line) || line.isSidechain === true || !isRecord(line.message)) {
    return false;
  }

  return line.message.role === 'assistant' && line.message.usage !== undefined;
}

// Context fill only counts input-side tokens — output_tokens are produced by the model,
// not consumed as context input. Matches Claude Code's own context_window_percentage
// calculation (anthropics/claude-code#11008).
function getContextFillTokens(usage: unknown): number {
  if (!isRecord(usage)) {
    return 0;
  }

  return (
    numberValue(usage.input_tokens) +
    numberValue(usage.cache_read_input_tokens) +
    numberValue(usage.cache_creation_input_tokens)
  );
}

export function getModelLimits(model: string | undefined): ModelLimits {
  const normalizedModel = normalizeModelKey(model);

  if (normalizedModel !== undefined && Object.hasOwn(MODEL_TABLE, normalizedModel)) {
    return MODEL_TABLE[normalizedModel];
  }

  const fallback = resolveFamilyFallback(normalizedModel);

  if (normalizedModel !== undefined) {
    warnUnknownModelOnce(normalizedModel, fallback.contextWindow);
  }

  return fallback;
}

function resolveFamilyFallback(normalizedModel: string | undefined): ModelLimits {
  if (normalizedModel === undefined) {
    return DEFAULT_MODEL_LIMITS;
  }

  if (normalizedModel.startsWith('claude-opus-')) {
    return { contextWindow: 200_000, maxOutputTokens: 32_000 };
  }

  if (normalizedModel.startsWith('claude-sonnet-')) {
    return { contextWindow: 200_000, maxOutputTokens: 8_192 };
  }

  if (normalizedModel.startsWith('claude-haiku-')) {
    return { contextWindow: 200_000, maxOutputTokens: 8_192 };
  }

  return DEFAULT_MODEL_LIMITS;
}

/**
 * Context window and reserve values are based on the upstream Claude Code Stop hook
 * measurement in anthropics/claude-code#11008.
 */
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
  warnInvalidUsageOnce(usage, sessionPath);
  const totalTokens = getContextFillTokens(usage);
  const model = normalizeModel(line.message);
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
  private claudeRootWatcherSetup: Promise<void> | undefined;
  private ideWatcher: fs.FSWatcher | undefined;
  private ideWatcherSetup: Promise<void> | undefined;
  private projectWatcher: fs.FSWatcher | undefined;
  private watchFactory: typeof fs.watch = fs.watch;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollJsonlPath: string | undefined;
  private pollInFlight: Promise<void> | undefined;
  private claudeRootWatcherRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReadAt = 0;
  private pendingTick = false;
  private currentProjectDir: string | undefined;
  private readonly offsets = new Map<string, number>();
  private readonly remainders = new Map<string, string>();
  private readonly readNewBytesInFlight = new Map<string, Promise<void>>();
  private readonly lockCache = new Map<string, CachedLockFile>();
  private ideDirectoryCache: CachedIdeDirectory | undefined;
  private disposed = false;
  private refreshing: Promise<void> | undefined;
  private pendingDispose: Promise<void> | undefined;

  public readonly onDidChange: vscode.Event<ContextUpdate>;

  public constructor(vscodeApi: typeof vscode, watchFactory: typeof fs.watch = fs.watch) {
    this.vscodeApi = vscodeApi;
    this.watchFactory = watchFactory;
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

    this.clearActiveSessionPolling();

    if (this.claudeRootWatcherRetryTimer !== undefined) {
      clearTimeout(this.claudeRootWatcherRetryTimer);
      this.claudeRootWatcherRetryTimer = undefined;
    }

    // Capture in-flight work so any open file handles inside readNewBytes are
    // released before callers (e.g. tests) tear down the directory. The VSCode
    // Disposable contract requires dispose() to be synchronous, so the promise
    // is exposed via whenIdle() rather than awaited here.
    const pendingWork = [this.refreshing, this.pollInFlight, ...this.readNewBytesInFlight.values()].filter(
      (work): work is Promise<void> => work !== undefined
    );
    if (pendingWork.length > 0) {
      this.pendingDispose = Promise.all(pendingWork).then(() => undefined, () => undefined);
    }

    this.emitter.dispose();
  }

  /**
   * Resolves once any in-flight work started before dispose() has settled,
   * ensuring file handles opened by readNewBytes are closed. Tests and the
   * extension's deactivate path can await this to avoid Windows EBUSY when
   * removing temp directories. Safe to call before or after dispose().
   */
  public async whenIdle(): Promise<void> {
    const pending = [
      this.refreshing,
      this.pollInFlight,
      this.pendingDispose,
      this.claudeRootWatcherSetup,
      this.ideWatcherSetup,
      ...this.readNewBytesInFlight.values()
    ].filter(
      (work): work is Promise<void> => work !== undefined
    );

    if (pending.length > 0) {
      await Promise.all(pending).catch(() => undefined);
    }
  }

  private getClaudeRoot(): string {
    return path.join(os.homedir(), '.claude');
  }

  private getClaudeIdeRoot(): string {
    return path.join(this.getClaudeRoot(), 'ide');
  }

  private watchClaudeRoot(): void {
    if (this.disposed || this.claudeRootWatcher !== undefined || this.claudeRootWatcherSetup !== undefined) {
      return;
    }

    if (this.claudeRootWatcherRetryTimer !== undefined) {
      clearTimeout(this.claudeRootWatcherRetryTimer);
      this.claudeRootWatcherRetryTimer = undefined;
    }

    const claudeRoot = this.getClaudeRoot();

    this.claudeRootWatcherSetup = this.createWatcher(
      claudeRoot,
      () => {
        this.watchIdeRoot();
        this.scheduleRefresh(250);
      },
      (watcher) => {
        if (this.claudeRootWatcher === watcher) {
          this.claudeRootWatcher = undefined;
        }

        this.scheduleRefresh(CLAUDE_ROOT_WATCHER_ERROR_RETRY_MS);
      }
    ).then((watcher) => {
      if (this.disposed) {
        watcher.close();
        return;
      }

      this.claudeRootWatcher = watcher;
    }, (err: unknown) => {
      if (!this.disposed) {
        const message = err instanceof Error ? err.message : String(err);
        globalThis.console.warn('[vscode-claude-context] Failed to watch Claude root:', message);
        this.claudeRootWatcherSetup = undefined;
        this.scheduleClaudeRootWatcherRetry();
      }
    }).finally(() => {
      this.claudeRootWatcherSetup = undefined;
    });
  }

  private watchIdeRoot(): void {
    if (this.disposed || this.ideWatcher !== undefined || this.ideWatcherSetup !== undefined) {
      return;
    }

    this.ideWatcherSetup = this.createWatcher(
      this.getClaudeIdeRoot(),
      () => this.scheduleRefresh(250),
      (watcher) => {
        if (this.ideWatcher === watcher) {
          this.ideWatcher = undefined;
        }

        this.scheduleRefresh(WATCHER_ERROR_RETRY_MS);
      }
    )
      .then((watcher) => {
        if (this.disposed) {
          watcher.close();
          return;
        }

        this.ideWatcher = watcher;
      }, () => undefined)
      .finally(() => {
        this.ideWatcherSetup = undefined;
      });
  }

  private watchProjectDir(projectDir: string): void {
    if (this.currentProjectDir === projectDir && this.projectWatcher !== undefined) {
      return;
    }

    const targetDir = projectDir;
    this.projectWatcher?.close();
    this.projectWatcher = undefined;
    this.currentProjectDir = targetDir;

    this.createWatcher(
      targetDir,
      (_event, filename) => {
        const changedFilename = typeof filename === 'string' ? filename : filename?.toString();

        if (changedFilename === undefined || changedFilename.endsWith('.jsonl')) {
          this.scheduleTick();
        }
      },
      (watcher) => {
        if (this.projectWatcher === watcher) {
          this.projectWatcher = undefined;
        }

        this.scheduleRefresh(WATCHER_ERROR_RETRY_MS);
      }
    ).then((watcher) => {
      if (
        !this.disposed &&
        this.currentProjectDir === targetDir &&
        this.projectWatcher === undefined
      ) {
        this.projectWatcher = watcher;
      } else {
        watcher.close();
      }
    }, () => undefined);
  }

  private async createWatcher(
    dir: string,
    listener: (event: string, filename: string | Buffer | null) => void,
    onError: (watcher: fs.FSWatcher) => void = () => undefined
  ): Promise<fs.FSWatcher> {
    await fsp.access(dir);
    const watcher = this.watchFactory(dir, listener);

    watcher.on('error', (err: Error) => {
      if (this.disposed) {
        return;
      }

      globalThis.console.warn('[vscode-claude-context] FSWatcher error:', err.message);
      watcher.close();
      onError(watcher);
    });

    return watcher;
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
    this.refreshTimer.unref();
  }

  private scheduleTick(): void {
    if (this.disposed) {
      return;
    }

    if (this.refreshing !== undefined) {
      this.pendingTick = true;
      return;
    }

    if (this.tickTimer !== undefined) {
      return;
    }

    const elapsedMs = Date.now() - this.lastReadAt;
    const delayMs = Math.max(UPDATE_INTERVAL_MS - elapsedMs, 0);

    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      void this.refreshActiveSession();
    }, delayMs);
    this.tickTimer.unref();
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
        this.refreshing = undefined;
        this.drainPendingTick();
      });

    return this.refreshing;
  }

  private async refreshActiveSessionCore(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.watchClaudeRoot();
    this.watchIdeRoot();

    const activeSession = await this.findActiveSession();

    if (activeSession === undefined) {
      this.clearActiveSessionPolling();
      this.projectWatcher?.close();
      this.projectWatcher = undefined;
      this.currentProjectDir = undefined;
      this.emitUpdate({ error: SESSION_NOT_FOUND_ERROR });
      return;
    }

    this.pruneInactiveSessionState(activeSession.jsonlPath);
    this.watchProjectDir(activeSession.projectDir);
    this.startActiveSessionPolling(activeSession.jsonlPath);
    await this.readNewBytes(activeSession.jsonlPath);
  }

  private pruneInactiveSessionState(activeJsonlPath: string): void {
    for (const filePath of this.offsets.keys()) {
      if (filePath !== activeJsonlPath) {
        this.offsets.delete(filePath);
      }
    }

    for (const filePath of this.remainders.keys()) {
      if (filePath !== activeJsonlPath) {
        this.remainders.delete(filePath);
      }
    }
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
    const lockResults: Array<ResolvedLockSession | undefined> = [];

    for (const lockPath of locks) {
      let lockStats: fs.Stats;

      try {
        lockStats = await fsp.stat(lockPath);
      } catch {
        lockResults.push(undefined);
        continue;
      }

      const lock = await this.readLock(lockPath, lockStats.mtimeMs);
      const matchedFolder = lock.workspaceFolders.find((folder) =>
        normalizedWorkspaceFolders.includes(normalizeWorkspacePath(folder))
      );

      if (matchedFolder === undefined) {
        lockResults.push(undefined);
        continue;
      }

      const projectDir = path.join(this.getClaudeProjectsRoot(), slugify(matchedFolder));
      const jsonl = await this.findNewestJsonl(projectDir);

      if (jsonl === undefined) {
        lockResults.push(undefined);
        continue;
      }

      lockResults.push({
        lockPath,
        projectDir,
        jsonlPath: jsonl.path,
        lockMtimeMs: lockStats.mtimeMs,
        jsonlMtimeMs: jsonl.mtimeMs
      });
    }

    const resolvedLockResults = lockResults.filter(
      (result): result is ResolvedLockSession => result !== undefined
    );
    const staleBeforeMs = Date.now() - STALE_LOCK_TTL_MS;
    const freshLockResults = resolvedLockResults.filter(
      (result) => result.lockMtimeMs >= staleBeforeMs || result.jsonlMtimeMs >= staleBeforeMs
    );
    const selectableLockResults =
      freshLockResults.length > 0 ? freshLockResults : resolvedLockResults;

    let bestSession: ActiveSession | undefined;
    let bestLockMtimeMs = -1;
    let bestJsonlMtimeMs = -1;
    let bestLockPath = '';

    for (const result of selectableLockResults) {
      if (
        result.lockMtimeMs > bestLockMtimeMs ||
          (result.lockMtimeMs === bestLockMtimeMs &&
            (result.jsonlMtimeMs > bestJsonlMtimeMs ||
              (result.jsonlMtimeMs === bestJsonlMtimeMs &&
                (bestSession === undefined || result.lockPath < bestLockPath))))
      ) {
        bestLockMtimeMs = result.lockMtimeMs;
        bestJsonlMtimeMs = result.jsonlMtimeMs;
        bestLockPath = result.lockPath;
        bestSession = {
          projectDir: result.projectDir,
          jsonlPath: result.jsonlPath
        };
      }
    }

    return bestSession;
  }

  private async readLockFiles(): Promise<string[]> {
    const ideRoot = this.getClaudeIdeRoot();
    let stats: fs.Stats;

    try {
      stats = await fsp.stat(ideRoot);
    } catch {
      this.ideDirectoryCache = undefined;
      return [];
    }

    const cached = this.ideDirectoryCache;
    let lockPaths: string[];

    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) {
      lockPaths = cached.lockPaths;
    } else {
      let entries: fs.Dirent[];

      try {
        entries = await fsp.readdir(ideRoot, { withFileTypes: true });
      } catch {
        this.ideDirectoryCache = undefined;
        return [];
      }

      lockPaths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.lock'))
        .map((entry) => path.join(ideRoot, entry.name));

      this.ideDirectoryCache = {
        mtimeMs: stats.mtimeMs,
        lockPaths
      };
    }

    const lockPathSet = new Set(lockPaths);

    for (const cachedPath of this.lockCache.keys()) {
      if (!lockPathSet.has(cachedPath)) {
        this.lockCache.delete(cachedPath);
      }
    }

    return lockPaths;
  }

  private async readLock(
    lockPath: string,
    lockMtimeMs: number
  ): Promise<{ readonly workspaceFolders: readonly string[] }> {
    const cached = this.lockCache.get(lockPath);

    if (cached !== undefined && cached.mtimeMs === lockMtimeMs) {
      return { workspaceFolders: cached.workspaceFolders };
    }

    if (cached !== undefined) {
      this.lockCache.delete(lockPath);
    }

    let raw: string;

    try {
      raw = await fsp.readFile(lockPath, 'utf8');
    } catch {
      this.lockCache.delete(lockPath);
      return { workspaceFolders: [] };
    }

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (!isRecord(parsed) || !Array.isArray(parsed.workspaceFolders)) {
        return { workspaceFolders: [] };
      }

      const workspaceFolders = parsed.workspaceFolders.filter(
        (folder): folder is string => typeof folder === 'string'
      );

      this.lockCache.set(lockPath, { mtimeMs: lockMtimeMs, workspaceFolders });

      return { workspaceFolders };
    } catch {
      this.lockCache.delete(lockPath);
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
    const previous = this.readNewBytesInFlight.get(filePath) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.readNewBytesCore(filePath));

    this.readNewBytesInFlight.set(filePath, current);

    try {
      await current;
    } finally {
      this.lastReadAt = Date.now();

      if (this.readNewBytesInFlight.get(filePath) === current) {
        this.readNewBytesInFlight.delete(filePath);
      }
    }
  }

  private async readNewBytesCore(filePath: string): Promise<void> {
    let stats: fs.Stats;

    try {
      stats = await fsp.stat(filePath);
    } catch {
      this.offsets.delete(filePath);
      this.remainders.delete(filePath);
      this.emitUpdate({ error: SESSION_NOT_FOUND_ERROR });
      return;
    }

    const previousOffset = this.offsets.get(filePath);

    if (previousOffset === undefined) {
      await this.readLatestExistingUpdate(filePath, stats.size);
      this.offsets.set(filePath, stats.size);
      return;
    }

    const truncated = stats.size < previousOffset;

    if (truncated) {
      this.offsets.set(filePath, 0);
      this.remainders.delete(filePath);
    }

    const offset = truncated ? 0 : previousOffset;

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

  private async readLatestExistingUpdate(filePath: string, size: number): Promise<void> {
    if (size <= 0) {
      return;
    }

    const offset = Math.max(0, size - INITIAL_TAIL_READ_BYTES);
    const length = size - offset;
    const handle = await fsp.open(filePath, 'r');

    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      let startsOnLineBoundary = offset === 0;

      if (offset > 0) {
        const previousByte = Buffer.alloc(1);
        const { bytesRead: previousBytesRead } = await handle.read(
          previousByte,
          0,
          previousByte.length,
          offset - 1
        );
        startsOnLineBoundary = previousBytesRead === 1 && previousByte[0] === 0x0a;
      }

      let lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);

      if (lines.at(-1) === '') {
        lines = lines.slice(0, -1);
      }

      if (!startsOnLineBoundary) {
        lines = lines.slice(1);
      }

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];

        if (line.trim() === '') {
          continue;
        }

        const update = parseContextUpdateFromLine(line, filePath);

        if (update !== undefined) {
          this.emitUpdate(update);
          return;
        }
      }
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

  private drainPendingTick(): void {
    if (!this.pendingTick || this.disposed) {
      return;
    }

    this.pendingTick = false;
    this.scheduleTick();
  }

  private startActiveSessionPolling(jsonlPath: string): void {
    if (this.disposed) {
      return;
    }

    if (this.pollTimer !== undefined && this.pollJsonlPath === jsonlPath) {
      return;
    }

    this.clearActiveSessionPolling();
    this.pollJsonlPath = jsonlPath;
    this.pollTimer = setInterval(() => {
      if (this.disposed || this.pollInFlight !== undefined) {
        return;
      }

      this.pollInFlight = this.readNewBytes(jsonlPath)
        .catch(() => {
          if (!this.disposed) {
            this.emitUpdate({ error: SESSION_NOT_FOUND_ERROR });
          }
        })
        .finally(() => {
          this.pollInFlight = undefined;
        });
    }, UPDATE_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private clearActiveSessionPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    this.pollJsonlPath = undefined;
  }

  private scheduleClaudeRootWatcherRetry(): void {
    if (
      this.disposed ||
      this.claudeRootWatcher !== undefined ||
      this.claudeRootWatcherSetup !== undefined ||
      this.claudeRootWatcherRetryTimer !== undefined
    ) {
      return;
    }

    this.claudeRootWatcherRetryTimer = setTimeout(() => {
      this.claudeRootWatcherRetryTimer = undefined;
      this.watchClaudeRoot();
    }, 60_000);
    this.claudeRootWatcherRetryTimer.unref();
  }
}

function normalizeWorkspacePath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeModel(message: unknown): string {
  if (!isRecord(message)) {
    return 'unknown/invalid';
  }

  if (!Object.hasOwn(message, 'model')) {
    return 'unknown/absent';
  }

  const model = message.model;

  if (typeof model !== 'string') {
    return 'unknown/invalid';
  }

  const normalizedModel = model.trim();

  return normalizedModel === '' ? 'unknown/invalid' : normalizedModel;
}

function normalizeModelKey(model: string | undefined): string | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }

  const normalizedModel = model.trim().toLowerCase();

  if (normalizedModel === '') {
    return undefined;
  }

  const suffixIndex = normalizedModel.indexOf(':');
  const withoutSuffix = suffixIndex === -1 ? normalizedModel : normalizedModel.slice(0, suffixIndex);

  return withoutSuffix.replace(/-(\d{8})$/, '');
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function warnInvalidUsageOnce(usage: unknown, sessionPath: string): void {
  if (!isRecord(usage) || warnedInvalidUsageSessionPaths.has(sessionPath)) {
    return;
  }

  const hasNumericTokenField = USAGE_TOKEN_FIELDS.some(
    (field) => typeof usage[field] === 'number' && Number.isFinite(usage[field])
  );

  if (hasNumericTokenField) {
    return;
  }

  warnedInvalidUsageSessionPaths.add(sessionPath);
  globalThis.console.warn(
    `[vscode-claude-context] Assistant usage has no numeric token fields in ${sessionPath}.`
  );
}

function warnUnknownModelOnce(model: string, contextWindow: number): void {
  if (warnedUnknownModels.has(model)) {
    return;
  }

  warnedUnknownModels.add(model);
  globalThis.console.warn(
    `[vscode-claude-context] Unknown Claude model "${model}" - using fallback limits (contextWindow=${contextWindow}).`
  );
}
