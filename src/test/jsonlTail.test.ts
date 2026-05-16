import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
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

test('findActiveSession reads lock files in parallel and caches unchanged lock files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-jsonl-tail-locks-'));
  const homeDir = path.join(root, 'home');
  const claudeRoot = path.join(homeDir, '.claude');
  const ideRoot = path.join(claudeRoot, 'ide');
  const workspaceRoot = path.join(root, 'workspace');
  const projectRoot = path.join(claudeRoot, 'projects', slugify(workspaceRoot));

  await mkdir(ideRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, 'session.jsonl'),
    JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))
  );

  await writeFile(
    path.join(ideRoot, 'one.lock'),
    JSON.stringify({ workspaceFolders: [workspaceRoot] })
  );
  await writeFile(
    path.join(ideRoot, 'two.lock'),
    JSON.stringify({ workspaceFolders: [path.join(root, 'other-workspace')] })
  );

  const mutableFsp = fsp as {
    readFile: typeof fsp.readFile;
  };

  const originalReadFile = mutableFsp.readFile;
  const originalEnv = {
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    USERPROFILE: process.env.USERPROFILE
  };
  let activeLockReads = 0;
  let maxConcurrentLockReads = 0;
  let lockReadCount = 0;

  process.env.HOME = homeDir;
  process.env.HOMEDRIVE = homeDir.slice(0, 2);
  process.env.HOMEPATH = homeDir.slice(2);
  process.env.USERPROFILE = homeDir;
  mutableFsp.readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
    const [filePath] = args;

    if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
      activeLockReads += 1;
      maxConcurrentLockReads = Math.max(maxConcurrentLockReads, activeLockReads);
      lockReadCount += 1;
      await delay(50);
      activeLockReads -= 1;
    }

    return originalReadFile(...args);
  }) as typeof fsp.readFile;

  try {
    const vscodeApi = createMockVscode([]);
    const mutableVscode = vscodeApi as unknown as {
      workspace: {
        workspaceFolders: Array<{ uri: { fsPath: string } }>;
      };
    };

    const dataSource = new JsonlTailDataSource(vscodeApi);
    await delay(0);
    mutableVscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];

    const first = await (dataSource as unknown as {
      findActiveSession: () => Promise<{ projectDir: string; jsonlPath: string } | undefined>;
    }).findActiveSession();
    const second = await (dataSource as unknown as {
      findActiveSession: () => Promise<{ projectDir: string; jsonlPath: string } | undefined>;
    }).findActiveSession();

    assert.equal(first?.projectDir, projectRoot);
    assert.equal(first?.jsonlPath, path.join(projectRoot, 'session.jsonl'));
    assert.equal(second?.projectDir, projectRoot);
    assert.equal(second?.jsonlPath, path.join(projectRoot, 'session.jsonl'));
    assert.equal(lockReadCount, 2);
    assert.equal(maxConcurrentLockReads, 2);

    dataSource.dispose();
  } finally {
    mutableFsp.readFile = originalReadFile;
    process.env.HOME = originalEnv.HOME;
    process.env.HOMEDRIVE = originalEnv.HOMEDRIVE;
    process.env.HOMEPATH = originalEnv.HOMEPATH;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(root, { recursive: true, force: true });
  }
});

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
      lockCache: Map<string, { readonly workspaceFolders: readonly string[] }>;
      readLockFiles: () => Promise<string[]>;
    };

    mutable.ideDirectoryCache = {
      mtimeMs: stats.mtimeMs,
      lockPaths: [activeLockPath]
    };
    mutable.lockCache = new Map([
      [activeLockPath, { workspaceFolders: [activeLockPath] }],
      [staleLockPath, { workspaceFolders: [staleLockPath] }]
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

test('JsonlTailDataSource seeds the offset on first encounter of an existing jsonl file', async () => {
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
    await delay(50);
    assert.equal(dataSource.getLatest().error, 'Claude Code session not found');

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

test('JsonlTailDataSource clears stale remainders after jsonl truncation', async () => {
  const fixture = await createClaudeFixture('claude-jsonl-tail-truncation-');
  const originalEnv = snapshotProcessEnv();

  applyClaudeHome(fixture.homeDir);

  const oldTurn = `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 10))}\n`;
  const staleRemainder =
    '{"timestamp":"2026-05-16T11:00:01Z","type":"message","message":{"role":"assistant","usage":{"input_tokens":';
  const newTurn = `${JSON.stringify(makeAssistantLine('2026-05-16T11:05:00Z', 42))}\n`;

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

    await writeFile(fixture.sessionPath, newTurn);

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
