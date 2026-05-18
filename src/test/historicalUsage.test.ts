import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoricalUsageReader, parseHistoricalUsageLine } from '../dataSource/historicalUsage';

const NOW = Date.parse('2026-05-16T12:00:00Z');

test('historical parser sums assistant budget usage with timestamp', () => {
  const line = {
    timestamp: '2026-05-16T11:00:00Z',
    type: 'message',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: 40
      }
    }
  };

  assert.deepEqual(parseHistoricalUsageLine(JSON.stringify(line)), {
    timestampMs: Date.parse(line.timestamp),
    tokens: 80,
    model: 'unknown/absent'
  });
});

test('historical parser excludes cache read tokens from budget usage', () => {
  const line = {
    timestamp: '2026-05-16T11:00:00Z',
    type: 'message',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 30,
        output_tokens: 40
      }
    }
  };

  const entry = parseHistoricalUsageLine(JSON.stringify(line));

  assert.equal(entry?.tokens, 80);
});

test('historical parser ignores sidechain and invalid timestamps', () => {
  assert.equal(
    parseHistoricalUsageLine(
      JSON.stringify({
        timestamp: '2026-05-16T11:00:00Z',
        isSidechain: true,
        message: { role: 'assistant', usage: { input_tokens: 10 } }
      })
    ),
    undefined
  );

  assert.equal(
    parseHistoricalUsageLine(
      JSON.stringify({
        timestamp: 'not-a-date',
        message: { role: 'assistant', usage: { input_tokens: 10 } }
      })
    ),
    undefined
  );
});

test('historical reader scans jsonl recursively and buckets 5h and 7d windows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-'));

  try {
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);
    await writeFile(
      path.join(projectDir, 'session.jsonl'),
      [
        JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100)),
        JSON.stringify(makeAssistantLine('2026-05-15T11:00:00Z', 200)),
        JSON.stringify(makeAssistantLine('2026-05-01T11:00:00Z', 300))
      ].join('\n')
    );

    const reader = new HistoricalUsageReader(root);
    const snapshot = await reader.refresh(NOW);

    assert.equal(snapshot.hasData, true);
    assert.equal(snapshot.tokens5h, 100);
    assert.equal(snapshot.tokens7d, 300);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader groups usage by model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-models-'));

  try {
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);
    await writeFile(
      path.join(projectDir, 'session.jsonl'),
      [
        JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100, 'claude-sonnet-4-6')),
        JSON.stringify(makeAssistantLine('2026-05-16T10:00:00Z', 200, 'claude-opus-4-7')),
        JSON.stringify(makeAssistantLine('2026-05-15T11:00:00Z', 300, 'claude-sonnet-4-6')),
        JSON.stringify(makeAssistantLine('2026-05-16T09:00:00Z', 400)),
        JSON.stringify(makeAssistantLine('2026-05-16T08:00:00Z', 500, 123))
      ].join('\n')
    );

    const reader = new HistoricalUsageReader(root);
    const snapshot = await reader.refresh(NOW);

    assert.deepEqual(snapshot.byModel.get('claude-sonnet-4-6'), {
      tokens5h: 100,
      tokens7d: 400
    });
    assert.deepEqual(snapshot.byModel.get('claude-opus-4-7'), {
      tokens5h: 200,
      tokens7d: 200
    });
    assert.deepEqual(snapshot.byModel.get('unknown/absent'), {
      tokens5h: 400,
      tokens7d: 400
    });
    assert.deepEqual(snapshot.byModel.get('unknown/invalid'), {
      tokens5h: 500,
      tokens7d: 500
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader refreshes changed files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-cache-'));

  try {
    const filePath = path.join(root, 'session.jsonl');
    await writeFile(filePath, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))}\n`);

    const fixedTime = new Date('2026-05-16T11:30:00Z');
    await utimes(filePath, fixedTime, fixedTime);

    const reader = new HistoricalUsageReader(root);
    const first = await reader.refresh(NOW);
    assert.equal(first.tokens5h, 100);

    await writeFile(
      filePath,
      [
        JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100)),
        JSON.stringify(makeAssistantLine('2026-05-16T11:30:00Z', 400))
      ].join('\n') + '\n'
    );

    const second = await reader.refresh(NOW);
    assert.equal(second.tokens5h, 500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader re-reads truncated files from scratch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-truncate-'));

  try {
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);

    const filePath = path.join(projectDir, 'session.jsonl');
    const firstLine = JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100));
    const secondLine = JSON.stringify(makeAssistantLine('2026-05-16T11:30:00Z', 200));
    const truncatedLine = JSON.stringify(makeAssistantLine('2026-05-16T11:45:00Z', 400));

    await writeFile(filePath, `${firstLine}\n${secondLine}\n`);

    const reader = new HistoricalUsageReader(root);
    const first = await reader.refresh(NOW);
    assert.equal(first.tokens5h, 300);

    await writeFile(filePath, `${truncatedLine}\n`);

    const second = await reader.refresh(NOW);
    assert.equal(second.tokens5h, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader ignores touch-only mtime changes when file size is unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-touch-'));

  try {
    const filePath = path.join(root, 'session.jsonl');
    await writeFile(filePath, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))}\n`);

    const reader = new HistoricalUsageReader(root);
    const mutable = reader as unknown as {
      readEntireFile: (jsonlPath: string, minTimestamp: number) => Promise<unknown[]>;
    };
    const originalReadEntireFile = mutable.readEntireFile.bind(reader);
    let readEntireFileCalls = 0;

    mutable.readEntireFile = async (jsonlPath: string, minTimestamp: number) => {
      readEntireFileCalls += 1;
      return originalReadEntireFile(jsonlPath, minTimestamp);
    };

    const first = await reader.refresh(NOW);
    assert.equal(first.tokens5h, 100);
    assert.equal(readEntireFileCalls, 1);

    const current = new Date('2026-05-16T11:30:00Z');
    await utimes(filePath, current, current);

    const second = await reader.refresh(NOW);
    assert.equal(second.tokens5h, 100);
    assert.equal(readEntireFileCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader prunes stale cached entries on cache hits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-prune-'));

  try {
    const filePath = path.join(root, 'session.jsonl');
    await writeFile(filePath, `${JSON.stringify(makeAssistantLine('2026-05-10T12:00:00Z', 100))}\n`);

    const reader = new HistoricalUsageReader(root);
    const first = await reader.refresh(NOW);
    assert.equal(first.tokens7d, 100);
    assert.equal(first.hasData, true);

    const later = Date.parse('2026-05-24T12:00:00Z');
    const second = await reader.refresh(later);

    assert.equal(second.tokens7d, 0);
    assert.equal(second.hasData, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader deduplicates concurrent refresh work', async () => {
  const reader = new HistoricalUsageReader(path.join(tmpdir(), 'claude-history-inflight-root'));
  const mutable = reader as unknown as {
    findJsonlFiles: (dir: string) => Promise<string[]>;
    refreshFile: (jsonlPath: string, nowMs: number) => Promise<void>;
  };

  let findCalls = 0;
  let refreshFileCalls = 0;

  mutable.findJsonlFiles = async () => {
    findCalls += 1;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    return [path.join(tmpdir(), 'session.jsonl')];
  };

  mutable.refreshFile = async () => {
    refreshFileCalls += 1;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  };

  const first = reader.refresh(NOW);
  const second = reader.refresh(NOW);
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

  assert.equal(findCalls, 1);
  assert.equal(refreshFileCalls, 1);
  assert.strictEqual(firstSnapshot, secondSnapshot);
});

test('historical reader prunes stale directory cache entries on refresh', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-dir-cache-'));

  try {
    const projectDir = path.join(root, 'project');
    const filePath = path.join(projectDir, 'session.jsonl');
    const staleDirectory = path.join(root, 'stale-project');

    await mkdir(projectDir);
    await writeFile(filePath, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))}\n`);

    const reader = new HistoricalUsageReader(root);
    const mutable = reader as unknown as {
      directoryCache: Map<string, { readonly mtimeMs: number; readonly entries: readonly unknown[] }>;
    };

    mutable.directoryCache.set(staleDirectory, {
      mtimeMs: 1,
      entries: []
    });

    await reader.refresh(NOW);

    assert.equal(mutable.directoryCache.has(staleDirectory), false);
    assert.equal(mutable.directoryCache.has(root), true);
    assert.equal(mutable.directoryCache.has(projectDir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical reader removes deleted project directories from directory cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-history-dir-delete-'));

  try {
    const projectDir = path.join(root, 'deleted-project');
    const filePath = path.join(projectDir, 'session.jsonl');

    await mkdir(projectDir);
    await writeFile(filePath, `${JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100))}\n`);

    const reader = new HistoricalUsageReader(root);
    const mutable = reader as unknown as {
      directoryCache: Map<string, { readonly mtimeMs: number; readonly entries: readonly unknown[] }>;
    };

    await reader.refresh(NOW);

    assert.equal(mutable.directoryCache.has(root), true);
    assert.equal(mutable.directoryCache.has(projectDir), true);

    await rm(projectDir, { recursive: true, force: true });
    await reader.refresh(NOW);

    assert.equal(mutable.directoryCache.has(root), true);
    assert.equal(mutable.directoryCache.has(projectDir), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeAssistantLine(timestamp: string, inputTokens: number, model?: unknown): unknown {
  return {
    timestamp,
    type: 'message',
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0
      }
    }
  };
}
