import type * as fs from 'fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { ContextUpdate } from '../dataSource';
import { JsonlTailDataSource, slugify } from '../dataSource/jsonlTail';

class MockEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  };

  public fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

function createMockVscode(workspaceFolders: readonly string[]): typeof import('vscode') {
  return {
    EventEmitter: MockEventEmitter,
    workspace: {
      workspaceFolders: workspaceFolders.map((fsPath) => ({
        uri: { fsPath }
      }))
    }
  } as unknown as typeof import('vscode');
}

class FakeWatcher {
  public closed = 0;
  private errorListener: ((err: Error) => void) | undefined;

  public constructor(public readonly dir: string) {}

  public on(event: string, listener: (err: Error) => void): this {
    if (event === 'error') {
      this.errorListener = listener;
    }

    return this;
  }

  public close(): void {
    this.closed += 1;
  }

  public emitError(message: string): void {
    this.errorListener?.(new Error(message));
  }
}

test('readLockFiles prunes stale cache entries on cache hit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-prune-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');

  await mkdir(ideRoot, { recursive: true });

  const originalEnv = snapshotProcessEnv();
  applyClaudeHome(homeDir);

  const dataSource = new JsonlTailDataSource(createMockVscode([]));

  try {
    await delay(25);

    const stats = await fsp.stat(ideRoot);
    const activeLockPath = path.join(ideRoot, 'active.lock');
    const staleLockPath = path.join(ideRoot, 'stale.lock');
    const mutable = dataSource as unknown as {
      ideDirectoryCache: { readonly mtimeMs: number; readonly lockPaths: string[] } | undefined;
      lockCache: Map<string, { readonly mtimeMs: number; readonly workspaceFolders: readonly string[] }>;
      readLockFiles: () => Promise<string[]>;
    };

    mutable.ideDirectoryCache = {
      mtimeMs: stats.mtimeMs,
      lockPaths: [activeLockPath]
    };
    mutable.lockCache = new Map([
      [activeLockPath, { mtimeMs: stats.mtimeMs, workspaceFolders: [activeLockPath] }],
      [staleLockPath, { mtimeMs: stats.mtimeMs, workspaceFolders: [staleLockPath] }]
    ]);

    const lockPaths = await mutable.readLockFiles();

    assert.deepEqual(lockPaths, [activeLockPath]);
    assert.equal(mutable.lockCache.has(activeLockPath), true);
    assert.equal(mutable.lockCache.has(staleLockPath), false);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('readLock invalidates cached workspace folders when lock mtime changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-lock-cache-'));
  const lockPath = path.join(root, 'active.lock');
  const dataSource = new JsonlTailDataSource(createMockVscode([]));

  try {
    await writeFile(lockPath, JSON.stringify({ workspaceFolders: ['workspace-a'] }));
    const firstTime = new Date('2026-05-16T11:00:00Z');
    await utimes(lockPath, firstTime, firstTime);
    const firstStats = await fsp.stat(lockPath);
    const mutable = dataSource as unknown as {
      lockCache: Map<string, { readonly mtimeMs: number; readonly workspaceFolders: readonly string[] }>;
      readLock: (
        lockPath: string,
        lockMtimeMs: number
      ) => Promise<{ readonly workspaceFolders: readonly string[] }>;
    };

    const firstLock = await mutable.readLock(lockPath, firstStats.mtimeMs);
    assert.deepEqual(firstLock.workspaceFolders, ['workspace-a']);

    await writeFile(lockPath, JSON.stringify({ workspaceFolders: ['workspace-b'] }));
    const secondTime = new Date('2026-05-16T11:01:00Z');
    await utimes(lockPath, secondTime, secondTime);
    const secondStats = await fsp.stat(lockPath);

    const secondLock = await mutable.readLock(lockPath, secondStats.mtimeMs);

    assert.deepEqual(secondLock.workspaceFolders, ['workspace-b']);
    assert.equal(mutable.lockCache.get(lockPath)?.mtimeMs, secondStats.mtimeMs);
  } finally {
    dataSource.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('watchProjectDir keeps the latest watcher when an older setup resolves late', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-watch-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const projectDir = path.join(root, 'project');

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  const mutableFsp = fsp as {
    access: typeof fsp.access;
  };

  const originalAccess = mutableFsp.access;
  const originalEnv = {
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    USERPROFILE: process.env.USERPROFILE
  };
  const accessCounts = new Map<string, number>();

  process.env.HOME = homeDir;
  process.env.HOMEDRIVE = homeDir.slice(0, 2);
  process.env.HOMEPATH = homeDir.slice(2);
  process.env.USERPROFILE = homeDir;
  mutableFsp.access = (async (dir: string) => {
    const count = (accessCounts.get(dir) ?? 0) + 1;
    accessCounts.set(dir, count);

    if (dir === projectDir) {
      await delay(count === 1 ? 50 : 0);
    } else {
      await delay(0);
    }
  }) as typeof fsp.access;

  try {
    const dataSource = new JsonlTailDataSource(createMockVscode([]));
    await delay(0);

    (dataSource as unknown as { watchProjectDir: (dir: string) => void }).watchProjectDir(
      projectDir
    );
    await delay(5);
    (dataSource as unknown as { watchProjectDir: (dir: string) => void }).watchProjectDir(
      projectDir
    );

    await delay(20);
    const watcherAfterSecond = (dataSource as unknown as {
      projectWatcher: unknown;
    }).projectWatcher;
    await delay(100);
    const finalWatcher = (dataSource as unknown as { projectWatcher: unknown }).projectWatcher;

    assert.ok(watcherAfterSecond !== undefined);
    assert.equal(finalWatcher, watcherAfterSecond);

    dataSource.dispose();
  } finally {
    mutableFsp.access = originalAccess;
    process.env.HOME = originalEnv.HOME;
    process.env.HOMEDRIVE = originalEnv.HOMEDRIVE;
    process.env.HOMEPATH = originalEnv.HOMEPATH;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(root, { recursive: true, force: true });
  }
});

test('findActiveSession resolves locks sequentially', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-lock-seq-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceRoot = path.join(root, 'workspace');
  const projectDir = path.join(claudeRoot, 'projects', slugify(workspaceRoot));

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  const originalEnv = snapshotProcessEnv();
  applyClaudeHome(homeDir);

  const vscodeApi = createMockVscode([workspaceRoot]);
  const dataSource = new JsonlTailDataSource(vscodeApi);
  const mutable = dataSource as unknown as {
    readLockFiles: () => Promise<string[]>;
    readLock: (
      lockPath: string,
      lockMtimeMs: number
    ) => Promise<{ readonly workspaceFolders: readonly string[] }>;
    findNewestJsonl: (dir: string) => Promise<{ readonly path: string; readonly mtimeMs: number } | undefined>;
    findActiveSession: () => Promise<{ readonly projectDir: string; readonly jsonlPath: string } | undefined>;
  };
  const lockPaths = [path.join(ideRoot, 'a.lock'), path.join(ideRoot, 'b.lock'), path.join(ideRoot, 'c.lock')];
  let activeReads = 0;
  let maxConcurrentReads = 0;
  let readLockCalls = 0;

  try {
    for (const lockPath of lockPaths) {
      await writeFile(lockPath, JSON.stringify({ workspaceFolders: [workspaceRoot] }));
    }

    await delay(25);
    await (dataSource as unknown as { refreshing?: Promise<void> }).refreshing;

    readLockCalls = 0;
    activeReads = 0;
    maxConcurrentReads = 0;

    mutable.readLockFiles = async () => lockPaths;
    mutable.readLock = async () => {
      readLockCalls += 1;
      activeReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);

      try {
        await delay(40);
        return { workspaceFolders: [workspaceRoot] };
      } finally {
        activeReads -= 1;
      }
    };
    mutable.findNewestJsonl = async (dir: string) => ({
      path: path.join(dir, 'session.jsonl'),
      mtimeMs: 1
    });

    await mutable.findActiveSession();

    assert.equal(readLockCalls, 3);
    assert.equal(maxConcurrentReads, 1);

    dataSource.dispose();
  } finally {
    restoreProcessEnv(originalEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('findActiveSession prefers the newest lock file when jsonl mtimes disagree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-lock-mtime-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const projectA = path.join(claudeRoot, 'projects', slugify(workspaceA));
  const projectB = path.join(claudeRoot, 'projects', slugify(workspaceB));
  const jsonlA = path.join(projectA, 'session.jsonl');
  const jsonlB = path.join(projectB, 'session.jsonl');
  const lockA = path.join(ideRoot, 'a.lock');
  const lockB = path.join(ideRoot, 'b.lock');

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const originalEnv = snapshotProcessEnv();
  applyClaudeHome(homeDir);

  await writeFile(jsonlB, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 20))}\n`);
  await delay(25);
  await writeFile(jsonlA, `${JSON.stringify(makeAssistantLine('2026-05-16T11:05:00Z', 40))}\n`);
  await delay(25);
  await writeFile(lockA, JSON.stringify({ workspaceFolders: [workspaceA] }));
  await delay(25);
  await writeFile(lockB, JSON.stringify({ workspaceFolders: [workspaceB] }));

  const dataSource = new JsonlTailDataSource(createMockVscode([workspaceA, workspaceB]));

  try {
    await delay(50);

    const session = await (dataSource as unknown as {
      findActiveSession: () => Promise<{ readonly projectDir: string; readonly jsonlPath: string } | undefined>;
    }).findActiveSession();

    assert.equal(session?.projectDir, projectB);
    assert.equal(session?.jsonlPath, jsonlB);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('findActiveSession ignores stale locks when the jsonl is stale too', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-stale-lock-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const projectA = path.join(claudeRoot, 'projects', slugify(workspaceA));
  const projectB = path.join(claudeRoot, 'projects', slugify(workspaceB));
  const jsonlA = path.join(projectA, 'session.jsonl');
  const jsonlB = path.join(projectB, 'session.jsonl');
  const lockA = path.join(ideRoot, 'a.lock');
  const lockB = path.join(ideRoot, 'b.lock');

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const originalEnv = snapshotProcessEnv();
  applyClaudeHome(homeDir);

  await writeFile(lockA, JSON.stringify({ workspaceFolders: [workspaceA] }));
  await writeFile(lockB, JSON.stringify({ workspaceFolders: [workspaceB] }));
  await writeFile(jsonlA, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 40))}\n`);
  await writeFile(jsonlB, `${JSON.stringify(makeAssistantLine('2026-05-16T11:05:00Z', 20))}\n`);

  const freshJsonlTime = new Date();
  const olderActiveLockTime = new Date(Date.now() - 30 * 60 * 1000);
  const staleWinningLockTime = new Date(Date.now() - 20 * 60 * 1000);

  await utimes(lockA, olderActiveLockTime, olderActiveLockTime);
  await utimes(jsonlA, freshJsonlTime, freshJsonlTime);
  await utimes(lockB, staleWinningLockTime, staleWinningLockTime);
  await utimes(jsonlB, staleWinningLockTime, staleWinningLockTime);

  const dataSource = new JsonlTailDataSource(createMockVscode([workspaceA, workspaceB]));

  try {
    const session = await (dataSource as unknown as {
      findActiveSession: () => Promise<{ readonly projectDir: string; readonly jsonlPath: string } | undefined>;
    }).findActiveSession();

    assert.equal(session?.projectDir, projectA);
    assert.equal(session?.jsonlPath, jsonlA);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('findActiveSession falls back to the newest lock when all matches are stale', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-all-stale-locks-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const projectA = path.join(claudeRoot, 'projects', slugify(workspaceA));
  const projectB = path.join(claudeRoot, 'projects', slugify(workspaceB));
  const jsonlA = path.join(projectA, 'session.jsonl');
  const jsonlB = path.join(projectB, 'session.jsonl');
  const lockA = path.join(ideRoot, 'a.lock');
  const lockB = path.join(ideRoot, 'b.lock');

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const originalEnv = snapshotProcessEnv();
  applyClaudeHome(homeDir);

  await writeFile(lockA, JSON.stringify({ workspaceFolders: [workspaceA] }));
  await writeFile(lockB, JSON.stringify({ workspaceFolders: [workspaceB] }));
  await writeFile(jsonlA, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 20))}\n`);
  await writeFile(jsonlB, `${JSON.stringify(makeAssistantLine('2026-05-16T11:05:00Z', 40))}\n`);

  const staleOlderTime = new Date(Date.now() - 30 * 60 * 1000);
  const staleNewerTime = new Date(Date.now() - 20 * 60 * 1000);

  await utimes(lockA, staleOlderTime, staleOlderTime);
  await utimes(jsonlA, staleOlderTime, staleOlderTime);
  await utimes(lockB, staleNewerTime, staleNewerTime);
  await utimes(jsonlB, staleOlderTime, staleOlderTime);

  const dataSource = new JsonlTailDataSource(createMockVscode([workspaceA, workspaceB]));

  try {
    const session = await (dataSource as unknown as {
      findActiveSession: () => Promise<{ readonly projectDir: string; readonly jsonlPath: string } | undefined>;
    }).findActiveSession();

    assert.equal(session?.projectDir, projectB);
    assert.equal(session?.jsonlPath, jsonlB);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('findActiveSession breaks equal mtime ties by lock path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-lock-tie-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const projectA = path.join(claudeRoot, 'projects', slugify(workspaceA));
  const projectB = path.join(claudeRoot, 'projects', slugify(workspaceB));
  const jsonlA = path.join(projectA, 'session.jsonl');
  const jsonlB = path.join(projectB, 'session.jsonl');
  const lockA = path.join(ideRoot, 'a.lock');
  const lockB = path.join(ideRoot, 'b.lock');

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  const originalEnv = snapshotProcessEnv();
  applyClaudeHome(homeDir);

  await writeFile(lockA, JSON.stringify({ workspaceFolders: [workspaceA] }));
  await writeFile(lockB, JSON.stringify({ workspaceFolders: [workspaceB] }));
  await writeFile(jsonlA, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 40))}\n`);
  await writeFile(jsonlB, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 40))}\n`);

  const sameTime = new Date('2026-05-16T11:00:00Z');
  await utimes(lockA, sameTime, sameTime);
  await utimes(lockB, sameTime, sameTime);
  await utimes(jsonlA, sameTime, sameTime);
  await utimes(jsonlB, sameTime, sameTime);

  const dataSource = new JsonlTailDataSource(createMockVscode([workspaceA, workspaceB]));

  try {
    await delay(25);

    const mutable = dataSource as unknown as {
      readLockFiles: () => Promise<string[]>;
      findActiveSession: () => Promise<{ readonly projectDir: string; readonly jsonlPath: string } | undefined>;
    };

    mutable.readLockFiles = async () => [lockB, lockA];

    const session = await mutable.findActiveSession();

    assert.equal(session?.projectDir, projectA);
    assert.equal(session?.jsonlPath, jsonlA);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource project watcher errors do not clear root watchers', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-project-error-');
  const originalEnv = snapshotProcessEnv();
  const scheduledRefreshes: number[] = [];
  const watchCalls: string[] = [];
  const watchers = new Map<string, FakeWatcher>();

  applyClaudeHome(fixture.homeDir);
  const fakeWatch = ((dir: string, listener: (event: string, filename: string | Buffer | null) => void) => {
    void listener;
    watchCalls.push(dir);
    const watcher = new FakeWatcher(dir);
    watchers.set(dir, watcher);
    return watcher as unknown as fs.FSWatcher;
  }) as typeof fs.watch;

  let dataSource: JsonlTailDataSource | undefined;

  try {
    dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]), fakeWatch);
    const mutable = dataSource as unknown as {
      claudeRootWatcher: FakeWatcher | undefined;
      ideWatcher: FakeWatcher | undefined;
      projectWatcher: FakeWatcher | undefined;
      watchProjectDir: (dir: string) => void;
      scheduleRefresh: (delayMs: number) => void;
    };

    await delay(25);

    const rootWatcher = mutable.claudeRootWatcher;
    const ideWatcher = mutable.ideWatcher;
    assert.ok(rootWatcher !== undefined);
    assert.ok(ideWatcher !== undefined);

    mutable.scheduleRefresh = (delayMs: number) => {
      scheduledRefreshes.push(delayMs);
    };

    mutable.watchProjectDir(fixture.projectRoot);
    await delay(25);

    const projectWatcher = mutable.projectWatcher;
    assert.ok(projectWatcher !== undefined);
    projectWatcher.emitError('project dir removed');

    assert.equal(projectWatcher.closed, 1);
    assert.equal(mutable.projectWatcher, undefined);
    assert.equal(mutable.claudeRootWatcher, rootWatcher);
    assert.equal(mutable.ideWatcher, ideWatcher);
    assert.deepEqual(scheduledRefreshes, [30_000]);
    assert.ok(watchCalls.includes(fixture.projectRoot));
  } finally {
    dataSource?.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource claude root watcher errors only clear the root watcher', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-root-error-');
  const originalEnv = snapshotProcessEnv();
  const scheduledRefreshes: number[] = [];

  applyClaudeHome(fixture.homeDir);
  const fakeWatch = ((dir: string, listener: (event: string, filename: string | Buffer | null) => void) => {
    void listener;
    return new FakeWatcher(dir) as unknown as fs.FSWatcher;
  }) as typeof fs.watch;

  let dataSource: JsonlTailDataSource | undefined;

  try {
    dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]), fakeWatch);
    const mutable = dataSource as unknown as {
      claudeRootWatcher: FakeWatcher | undefined;
      ideWatcher: FakeWatcher | undefined;
      scheduleRefresh: (delayMs: number) => void;
    };

    await delay(25);

    const rootWatcher = mutable.claudeRootWatcher;
    const ideWatcher = mutable.ideWatcher;
    assert.ok(rootWatcher !== undefined);
    assert.ok(ideWatcher !== undefined);

    mutable.scheduleRefresh = (delayMs: number) => {
      scheduledRefreshes.push(delayMs);
    };

    rootWatcher.emitError('directory removed');

    assert.equal(rootWatcher.closed, 1);
    assert.equal(mutable.claudeRootWatcher, undefined);
    assert.equal(mutable.ideWatcher, ideWatcher);
    assert.deepEqual(scheduledRefreshes, [60_000]);
  } finally {
    dataSource?.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource ide watcher errors only clear the ide watcher', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-ide-error-');
  const originalEnv = snapshotProcessEnv();
  const scheduledRefreshes: number[] = [];

  applyClaudeHome(fixture.homeDir);
  const fakeWatch = ((dir: string, listener: (event: string, filename: string | Buffer | null) => void) => {
    void listener;
    return new FakeWatcher(dir) as unknown as fs.FSWatcher;
  }) as typeof fs.watch;

  let dataSource: JsonlTailDataSource | undefined;

  try {
    dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]), fakeWatch);
    const mutable = dataSource as unknown as {
      claudeRootWatcher: FakeWatcher | undefined;
      ideWatcher: FakeWatcher | undefined;
      scheduleRefresh: (delayMs: number) => void;
    };

    await delay(25);

    const rootWatcher = mutable.claudeRootWatcher;
    const ideWatcher = mutable.ideWatcher;
    assert.ok(rootWatcher !== undefined);
    assert.ok(ideWatcher !== undefined);

    mutable.scheduleRefresh = (delayMs: number) => {
      scheduledRefreshes.push(delayMs);
    };

    ideWatcher.emitError('ide dir removed');

    assert.equal(ideWatcher.closed, 1);
    assert.equal(mutable.claudeRootWatcher, rootWatcher);
    assert.equal(mutable.ideWatcher, undefined);
    assert.deepEqual(scheduledRefreshes, [30_000]);
  } finally {
    dataSource?.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource emits updates when the active jsonl file is appended', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-append-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);
  await writeFile(fixture.sessionPath, '');
  const dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]));

  try {
    await delay(50);
    assert.equal(dataSource.getLatest().error, 'Claude Code session not found');

    const nextUpdate = waitForUpdate(dataSource, (update) => update.totalTokens === 100);
    await appendFile(
      fixture.sessionPath,
      `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))}\n`
    );
    await (dataSource as unknown as { readNewBytes: (filePath: string) => Promise<void> }).readNewBytes(
      fixture.sessionPath
    );

      const update = await nextUpdate;
      assert.equal(update.totalTokens, 100);
      assert.ok(update.fillPercent !== undefined);
      assert.equal(update.sessionPath, fixture.sessionPath);
      assert.ok((update.fillPercent ?? 0) > 0);
    } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource emits the latest existing turn on first encounter', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-offset-seed-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);
  await writeFile(
    fixture.sessionPath,
    Array.from({ length: 100 }, () =>
      JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 1))
    ).join('\n') + '\n'
  );

  const dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]));

  try {
    const initialUpdate = await waitForUpdate(dataSource, (update) => update.totalTokens === 1);
    assert.equal(initialUpdate.sessionPath, fixture.sessionPath);

    const nextUpdate = waitForUpdate(dataSource, (update) => update.totalTokens === 250);
    await appendFile(
      fixture.sessionPath,
      `${JSON.stringify(makeAssistantLine('2026-05-16T11:01:00Z', 250))}\n`
    );
    await (dataSource as unknown as { readNewBytes: (filePath: string) => Promise<void> }).readNewBytes(
      fixture.sessionPath
    );

    const update = await nextUpdate;
    assert.equal(update.totalTokens, 250);
    assert.equal(update.sessionPath, fixture.sessionPath);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource emits zero-token updates when a fresh session starts', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-zero-token-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);
  await writeFile(
    fixture.sessionPath,
    `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))}\n`
  );

  const dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]));

  try {
    const initialUpdate = await waitForUpdate(dataSource, (update) => update.totalTokens === 100);
    assert.equal(initialUpdate.sessionPath, fixture.sessionPath);

    const nextUpdate = waitForUpdate(dataSource, (update) => update.totalTokens === 0);
    await writeFile(
      fixture.sessionPath,
      `${JSON.stringify(makeAssistantLine('2026-05-16T11:01:00Z', 0))}\n`
    );
    await (dataSource as unknown as { readNewBytes: (filePath: string) => Promise<void> }).readNewBytes(
      fixture.sessionPath
    );

    const update = await nextUpdate;
    assert.equal(update.fillPercent, 0);
    assert.equal(update.totalTokens, 0);
    assert.equal(update.sessionPath, fixture.sessionPath);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource polls active jsonl appends without watcher events', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-poll-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);
  await writeFile(
    fixture.sessionPath,
    `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 10))}\n`
  );

  const fakeWatch = ((dir: string, listener: (event: string, filename: string | Buffer | null) => void) => {
    void listener;
    return new FakeWatcher(dir) as unknown as fs.FSWatcher;
  }) as typeof fs.watch;
  const dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]), fakeWatch);

  try {
    const initialUpdate = await waitForUpdate(dataSource, (update) => update.totalTokens === 10);
    assert.equal(initialUpdate.sessionPath, fixture.sessionPath);

    const nextUpdate = waitForUpdate(dataSource, (update) => update.totalTokens === 200, 7_000);
    await appendFile(
      fixture.sessionPath,
      `${JSON.stringify(makeAssistantLine('2026-05-16T11:01:00Z', 200))}\n`
    );

    const update = await nextUpdate;
    assert.equal(update.totalTokens, 200);
    assert.equal(update.sessionPath, fixture.sessionPath);
  } finally {
    dataSource.dispose();
    assert.equal((dataSource as unknown as { pollTimer: unknown }).pollTimer, undefined);
    await dataSource.whenIdle();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource clears stale remainders after jsonl truncation', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-truncation-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);

  const oldTurn = `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 10))}\n`;
  const staleRemainder =
    '{"timestamp":"2026-05-16T11:00:01Z","type":"message","message":{"role":"assistant","usage":{"input_tokens":';
  const newTurn = {
    ...((makeAssistantLine('2026-05-16T11:05:00Z', 42) as unknown) as Record<string, unknown>),
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 42,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0
      }
    }
  };

  await writeFile(fixture.sessionPath, `${oldTurn}${staleRemainder}`);

  const dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]));

  try {
    await delay(50);

    const mutable = dataSource as unknown as {
      offsets: Map<string, number>;
      remainders: Map<string, string>;
      readNewBytes: (filePath: string) => Promise<void>;
    };

    const oldStats = await fsp.stat(fixture.sessionPath);
    mutable.offsets.set(fixture.sessionPath, oldStats.size);
    mutable.remainders.set(fixture.sessionPath, staleRemainder);

    await writeFile(fixture.sessionPath, `${JSON.stringify(newTurn)}\n`);
    await fsp.utimes(
      fixture.sessionPath,
      new Date(oldStats.mtimeMs),
      new Date(oldStats.mtimeMs)
    );

    const nextUpdate = waitForUpdate(dataSource, (update) => update.totalTokens === 42);
    await mutable.readNewBytes(fixture.sessionPath);

    const update = await nextUpdate;
    assert.equal(update.totalTokens, 42);
    assert.equal(update.sessionPath, fixture.sessionPath);
    assert.equal(mutable.remainders.get(fixture.sessionPath) ?? '', '');
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refreshActiveSessionCore prunes inactive offsets and remainders', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  const activeJsonlPath = path.join('active', 'session.jsonl');
  const staleJsonlPath = path.join('stale', 'session.jsonl');
  const mutable = dataSource as unknown as {
    offsets: Map<string, number>;
    remainders: Map<string, string>;
    findActiveSession: () => Promise<{ readonly projectDir: string; readonly jsonlPath: string } | undefined>;
    watchProjectDir: (projectDir: string) => void;
    startActiveSessionPolling: (jsonlPath: string) => void;
    readNewBytes: (filePath: string) => Promise<void>;
    refreshActiveSessionCore: () => Promise<void>;
  };

  mutable.offsets.set(activeJsonlPath, 100);
  mutable.offsets.set(staleJsonlPath, 200);
  mutable.remainders.set(activeJsonlPath, 'active partial');
  mutable.remainders.set(staleJsonlPath, 'stale partial');
  mutable.findActiveSession = async () => ({
    projectDir: path.dirname(activeJsonlPath),
    jsonlPath: activeJsonlPath
  });
  mutable.watchProjectDir = () => undefined;
  mutable.startActiveSessionPolling = () => undefined;
  mutable.readNewBytes = async () => undefined;

  try {
    await mutable.refreshActiveSessionCore();

    assert.deepEqual(Array.from(mutable.offsets.entries()), [[activeJsonlPath, 100]]);
    assert.deepEqual(Array.from(mutable.remainders.entries()), [[activeJsonlPath, 'active partial']]);
  } finally {
    dataSource.dispose();
  }
});

test('scheduleTick measures cooldown from latest read completion', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  const mutable = dataSource as unknown as {
    scheduleTick: () => void;
    refreshActiveSessionCore: () => Promise<void>;
    readNewBytes: (filePath: string) => Promise<void>;
    readNewBytesCore: (filePath: string) => Promise<void>;
    lastReadAt: number;
  };

  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const before = Date.now();

  mutable.refreshActiveSessionCore = async () => {
    await refreshGate;
    await mutable.readNewBytes('session.jsonl');
  };
  mutable.readNewBytesCore = async () => undefined;

  try {
    mutable.lastReadAt = before - 5_000;
    mutable.scheduleTick();
    await delay(0);

    assert.equal(mutable.lastReadAt, before - 5_000);

    releaseRefresh?.();
    await delay(0);

    assert.ok(mutable.lastReadAt >= before);
  } finally {
    dataSource.dispose();
  }
});

test('readNewBytes updates lastReadAt before watcher debounce is calculated', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  const mutable = dataSource as unknown as {
    scheduleTick: () => void;
    refreshActiveSessionCore: () => Promise<void>;
    readNewBytes: (filePath: string) => Promise<void>;
    readNewBytesCore: (filePath: string) => Promise<void>;
    lastReadAt: number;
    tickTimer: unknown;
  };
  let refreshCalls = 0;
  const before = Date.now();

  mutable.readNewBytesCore = async () => undefined;
  mutable.refreshActiveSessionCore = async () => {
    refreshCalls += 1;
  };

  try {
    mutable.lastReadAt = before - 5_000;
    await mutable.readNewBytes('session.jsonl');

    assert.ok(mutable.lastReadAt >= before);

    mutable.scheduleTick();
    await delay(0);

    assert.equal(refreshCalls, 0);
    assert.notEqual(mutable.tickTimer, undefined);
  } finally {
    dataSource.dispose();
  }
});

test('scheduleTick queues a follow-up tick while refresh is in flight', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  const mutable = dataSource as unknown as {
    scheduleTick: () => void;
    refreshActiveSessionCore: () => Promise<void>;
    readNewBytes: (filePath: string) => Promise<void>;
    readNewBytesCore: (filePath: string) => Promise<void>;
    lastReadAt: number;
    pendingTick: boolean;
    tickTimer: unknown;
  };

  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  mutable.refreshActiveSessionCore = async () => {
    await refreshGate;
    await mutable.readNewBytes('session.jsonl');
  };
  mutable.readNewBytesCore = async () => undefined;

  try {
    mutable.lastReadAt = Date.now() - 5_000;
    mutable.scheduleTick();
    await delay(0);

    assert.equal(mutable.pendingTick, false);

    mutable.scheduleTick();
    assert.equal(mutable.pendingTick, true);

    releaseRefresh?.();
    await delay(0);

    assert.equal(mutable.pendingTick, false);
    assert.notEqual(mutable.tickTimer, undefined);
  } finally {
    dataSource.dispose();
  }
});

test('readLatestExistingUpdate keeps first tail line when offset starts after newline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-boundary-'));
  const sessionPath = path.join(root, 'session.jsonl');
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  const assistantLine = JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 42));
  const tailBytes = 16 * 1_024;
  const tail = `${assistantLine}\n${'\n'.repeat(tailBytes - assistantLine.length - 1)}`;
  const content = `line before tail window\n${tail}`;

  await writeFile(sessionPath, content);

  try {
    const mutable = dataSource as unknown as {
      readLatestExistingUpdate: (filePath: string, size: number) => Promise<void>;
    };

    await mutable.readLatestExistingUpdate(sessionPath, Buffer.byteLength(content));

    assert.equal(dataSource.getLatest().totalTokens, 42);
    assert.equal(dataSource.getLatest().sessionPath, sessionPath);
  } finally {
    dataSource.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('JsonlTailDataSource preserves CRLF boundaries across file chunks', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-crlf-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);
  await writeFile(fixture.sessionPath, '');
  const dataSource = new JsonlTailDataSource(createMockVscode([fixture.workspaceRoot]));

  try {
    await delay(25);

    const mutable = dataSource as unknown as {
      readNewBytes: (filePath: string) => Promise<void>;
    };

    await writeFile(
      fixture.sessionPath,
      `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 10))}\r`
    );
    await mutable.readNewBytes(fixture.sessionPath);
    assert.equal(dataSource.getLatest().error, 'Claude Code session not found');

    await appendFile(
      fixture.sessionPath,
      `\n${JSON.stringify(makeAssistantLine('2026-05-16T11:01:00Z', 20))}\r\n`
    );
    await mutable.readNewBytes(fixture.sessionPath);

    assert.equal(dataSource.getLatest().totalTokens, 20);
    assert.equal(dataSource.getLatest().sessionPath, fixture.sessionPath);
  } finally {
    dataSource.dispose();
    restoreProcessEnv(originalEnv);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('dispose captures in-flight refresh so whenIdle drains open file handles', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  const mutable = dataSource as unknown as {
    refreshActiveSession: () => Promise<void>;
    refreshActiveSessionCore: () => Promise<void>;
    refreshing?: Promise<void>;
    pendingDispose?: Promise<void>;
  };

  let releaseRefresh: (() => void) | undefined;
  let refreshSettled = false;
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  mutable.refreshActiveSessionCore = async () => {
    await gate;
    refreshSettled = true;
  };

  void mutable.refreshActiveSession();
  // Give the microtask queue a chance to assign `refreshing`.
  await delay(0);

  assert.notEqual(mutable.refreshing, undefined);

  dataSource.dispose();

  // dispose() must remain synchronous: the in-flight refresh is still pending.
  assert.equal(refreshSettled, false);
  assert.notEqual(mutable.pendingDispose, undefined);

  releaseRefresh?.();
  await dataSource.whenIdle();

  assert.equal(refreshSettled, true);
});

test('whenIdle waits for refresh and poll work that overlap', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);
  let releaseRefresh: (() => void) | undefined;
  let releasePoll: (() => void) | undefined;

  try {
    const mutable = dataSource as unknown as {
      refreshing?: Promise<void>;
      pollInFlight?: Promise<void>;
    };

    let refreshSettled = false;
    let pollSettled = false;

    mutable.refreshing = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }).then(() => {
      refreshSettled = true;
    });
    mutable.pollInFlight = new Promise<void>((resolve) => {
      releasePoll = resolve;
    }).then(() => {
      pollSettled = true;
    });

    const idle = dataSource.whenIdle();
    releaseRefresh?.();
    await delay(0);

    assert.equal(refreshSettled, true);
    assert.equal(pollSettled, false);

    releasePoll?.();
    await idle;

    assert.equal(pollSettled, true);
  } finally {
    releaseRefresh?.();
    releasePoll?.();
    dataSource.dispose();
    await dataSource.whenIdle();
  }
});

test('whenIdle waits for watcher setup work', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);
  let releaseClaudeRootWatcher: (() => void) | undefined;
  let releaseIdeWatcher: (() => void) | undefined;

  try {
    const mutable = dataSource as unknown as {
      claudeRootWatcherSetup?: Promise<void>;
      ideWatcherSetup?: Promise<void>;
    };

    let claudeRootWatcherSettled = false;
    let ideWatcherSettled = false;
    let idleSettled = false;

    mutable.claudeRootWatcherSetup = new Promise<void>((resolve) => {
      releaseClaudeRootWatcher = resolve;
    }).then(() => {
      claudeRootWatcherSettled = true;
    });
    mutable.ideWatcherSetup = new Promise<void>((resolve) => {
      releaseIdeWatcher = resolve;
    }).then(() => {
      ideWatcherSettled = true;
    });

    const idle = dataSource.whenIdle().then(() => {
      idleSettled = true;
    });

    releaseClaudeRootWatcher?.();
    await delay(0);

    assert.equal(claudeRootWatcherSettled, true);
    assert.equal(ideWatcherSettled, false);
    assert.equal(idleSettled, false);

    releaseIdeWatcher?.();
    await idle;

    assert.equal(ideWatcherSettled, true);
    assert.equal(idleSettled, true);
  } finally {
    releaseClaudeRootWatcher?.();
    releaseIdeWatcher?.();
    dataSource.dispose();
    await dataSource.whenIdle();
  }
});

test('whenIdle is safe to call when no refresh is in flight', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  // Drain the initial refresh kicked off by the constructor.
  await dataSource.whenIdle();

  dataSource.dispose();
  await dataSource.whenIdle();
  // Calling whenIdle twice after dispose must remain a no-op.
  await dataSource.whenIdle();
});

test('JsonlTailDataSource only runs one refresh core at a time', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  try {
    let activeRefreshes = 0;
    let maxConcurrentRefreshes = 0;
    let refreshCalls = 0;
    let releaseRefresh: (() => void) | undefined;

    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const mutable = dataSource as unknown as {
      refreshActiveSession: () => Promise<void>;
      refreshActiveSessionCore: () => Promise<void>;
      refreshing?: Promise<void>;
    };

    mutable.refreshActiveSessionCore = async () => {
      refreshCalls += 1;
      activeRefreshes += 1;
      maxConcurrentRefreshes = Math.max(maxConcurrentRefreshes, activeRefreshes);

      try {
        await gate;
      } finally {
        activeRefreshes -= 1;
      }
    };

    mutable.refreshActiveSession();
    const inFlight = mutable.refreshing;
    const second = mutable.refreshActiveSession();

    assert.equal(mutable.refreshing, inFlight);
    assert.equal(refreshCalls, 1);
    assert.equal(maxConcurrentRefreshes, 1);

    releaseRefresh?.();
    await inFlight;
    await second;
  } finally {
    dataSource.dispose();
  }
});

test('JsonlTailDataSource serializes readNewBytes calls for the same file', async () => {
  const dataSource = new JsonlTailDataSource(createMockVscode([]));
  await delay(25);

  try {
    const mutable = dataSource as unknown as {
      readNewBytes: (filePath: string) => Promise<void>;
      readNewBytesCore: (filePath: string) => Promise<void>;
    };
    const releases: Array<() => void> = [];
    let activeReads = 0;
    let readCalls = 0;
    let maxConcurrentReads = 0;

    mutable.readNewBytesCore = async () => {
      readCalls += 1;
      activeReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);

      try {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      } finally {
        activeReads -= 1;
      }
    };

    const first = mutable.readNewBytes('session.jsonl');
    const second = mutable.readNewBytes('session.jsonl');

    await delay(0);

    assert.equal(readCalls, 1);
    assert.equal(maxConcurrentReads, 1);

    releases[0]?.();
    await delay(0);

    assert.equal(readCalls, 2);
    assert.equal(maxConcurrentReads, 1);

    releases[1]?.();
    await Promise.all([first, second]);

    assert.equal(activeReads, 0);
  } finally {
    dataSource.dispose();
    await dataSource.whenIdle();
  }
});

function makeAssistantLine(timestamp: string, inputTokens: number): unknown {
  return {
    timestamp,
    type: 'message',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0
      }
    }
  };
}

async function waitForUpdate(
  dataSource: JsonlTailDataSource,
  predicate: (update: ContextUpdate) => boolean,
  timeoutMs = 5_000
): Promise<ContextUpdate> {
  return await new Promise<ContextUpdate>((resolve, reject) => {
    let disposable: { dispose(): void } | undefined;
    const timeout = setTimeout(() => {
      disposable?.dispose();
      reject(new Error('Timed out waiting for JsonlTailDataSource update'));
    }, timeoutMs);

    disposable = dataSource.onDidChange((update) => {
      if (!predicate(update)) {
        return;
      }

      clearTimeout(timeout);
      disposable?.dispose();
      resolve(update);
    });
  });
}

function snapshotProcessEnv(): typeof process.env {
  return {
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    USERPROFILE: process.env.USERPROFILE
  };
}

function applyClaudeHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.HOMEDRIVE = homeDir.slice(0, 2);
  process.env.HOMEPATH = homeDir.slice(2);
  process.env.USERPROFILE = homeDir;
}

function restoreProcessEnv(originalEnv: typeof process.env): void {
  process.env.HOME = originalEnv.HOME;
  process.env.HOMEDRIVE = originalEnv.HOMEDRIVE;
  process.env.HOMEPATH = originalEnv.HOMEPATH;
  process.env.USERPROFILE = originalEnv.USERPROFILE;
}

async function createClaudeFixture(prefix: string): Promise<{
  readonly root: string;
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly sessionPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceRoot = path.join(root, 'workspace');
  const projectRoot = path.join(claudeRoot, 'projects', slugify(workspaceRoot));
  const sessionPath = path.join(projectRoot, 'session.jsonl');

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(ideRoot, 'active.lock'),
    JSON.stringify({ workspaceFolders: [workspaceRoot] })
  );

  return {
    root,
    homeDir,
    workspaceRoot,
    projectRoot,
    sessionPath
  };
}
