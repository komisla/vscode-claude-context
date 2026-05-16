import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoricalUsageReader, parseHistoricalUsageLine } from '../dataSource/historicalUsage';

const NOW = Date.parse('2026-05-16T12:00:00Z');

test('historical parser sums assistant usage with timestamp', () => {
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
    tokens: 100,
    model: 'unknown/absent'
  });
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
    const snapshot = await reader.refresh({ budget5h: 1_000, budget7d: 1_000 }, NOW);

    assert.equal(snapshot.hasData, true);
    assert.equal(snapshot.tokens5h, 100);
    assert.equal(snapshot.tokens7d, 300);
    assert.equal(snapshot.pct5h, 10);
    assert.equal(snapshot.pct7d, 30);
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
    const snapshot = await reader.refresh({ budget5h: 1_000, budget7d: 2_000 }, NOW);

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
    await writeFile(filePath, JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 100)));

    const fixedTime = new Date('2026-05-16T11:30:00Z');
    await utimes(filePath, fixedTime, fixedTime);

    const reader = new HistoricalUsageReader(root);
    const first = await reader.refresh({ budget5h: 1_000, budget7d: 1_000 }, NOW);
    assert.equal(first.tokens5h, 100);

    await writeFile(filePath, JSON.stringify(makeAssistantLine('2026-05-16T11:00:00Z', 400)));
    const second = await reader.refresh({ budget5h: 1_000, budget7d: 1_000 }, NOW);
    assert.equal(second.tokens5h, 400);
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

  const first = reader.refresh({ budget5h: 1_000, budget7d: 1_000 }, NOW);
  const second = reader.refresh({ budget5h: 1_000, budget7d: 1_000 }, NOW);
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

  assert.equal(findCalls, 1);
  assert.equal(refreshFileCalls, 1);
  assert.strictEqual(firstSnapshot, secondSnapshot);
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
