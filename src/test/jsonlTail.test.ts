import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { tmpdir } from 'os';
import path from 'path';
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
