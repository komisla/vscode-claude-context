import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitReader, type RateLimitFetch, type RateLimitFetchInit } from '../dataSource/rateLimit';

const NOW = Date.parse('2026-05-18T10:00:00Z');

class TestHeaders {
  public constructor(private readonly values: Readonly<Record<string, string>>) {}

  public get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

test('RateLimitReader hides usage when credentials are missing', async () => {
  let fetchCalls = 0;
  const reader = new RateLimitReader({
    readFile: async () => {
      throw new Error('missing credentials');
    },
    fetch: async () => {
      fetchCalls += 1;
      return { headers: new TestHeaders({}) };
    }
  });

  const snapshot = await reader.refresh(NOW);

  assert.equal(snapshot, undefined);
  assert.equal(fetchCalls, 0);
});

test('RateLimitReader reads utilization and reset headers from the API response', async () => {
  let requestedUrl = '';
  let requestedInit: RateLimitFetchInit | undefined;
  const fetcher: RateLimitFetch = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return {
      headers: new TestHeaders({
        'anthropic-ratelimit-unified-5h-utilization': '0.123',
        'anthropic-ratelimit-unified-7d-utilization': '0.456',
        'anthropic-ratelimit-unified-5h-reset': '2026-05-18T12:00:00Z',
        'anthropic-ratelimit-unified-7d-reset': '2026-05-19T12:00:00Z'
      })
    };
  };
  const reader = new RateLimitReader({
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
    fetch: fetcher
  });

  const snapshot = await reader.refresh(NOW);

  assert.deepEqual(snapshot, {
    pct5h: 12.3,
    pct7d: 45.6,
    reset5h: '2026-05-18T12:00:00Z',
    reset7d: '2026-05-19T12:00:00Z'
  });
  assert.equal(requestedUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(requestedInit?.headers.Authorization, 'Bearer oauth-token');
  assert.equal(requestedInit?.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.notEqual(requestedInit?.signal, undefined);
  assert.equal(requestedInit?.signal?.aborted, false);
});

test('RateLimitReader aborts the API request when the fetch timeout elapses', async () => {
  const pending = deferred<{ readonly headers: TestHeaders }>();
  let requestedSignal: AbortSignal | undefined;
  const reader = new RateLimitReader({
    fetchTimeoutMs: 1,
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
    fetch: async (_url, init) => {
      requestedSignal = init.signal;
      init.signal?.addEventListener('abort', () => pending.reject(new Error('aborted')));
      return pending.promise;
    }
  });

  const snapshot = await reader.refresh(NOW);

  assert.equal(snapshot, undefined);
  assert.equal(requestedSignal?.aborted, true);
});

test('RateLimitReader hides usage when utilization headers are absent', async () => {
  const reader = new RateLimitReader({
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
    fetch: async () => ({ headers: new TestHeaders({}) })
  });

  const snapshot = await reader.refresh(NOW);

  assert.equal(snapshot, undefined);
});

test('RateLimitReader caches unavailable results for five minutes', async () => {
  let fetchCalls = 0;
  const reader = new RateLimitReader({
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
    fetch: async () => {
      fetchCalls += 1;
      return { headers: new TestHeaders({}) };
    }
  });

  await reader.refresh(NOW);
  await reader.refresh(NOW + 4 * 60_000 + 59_000);
  assert.equal(fetchCalls, 1);

  await reader.refresh(NOW + 5 * 60_000);

  assert.equal(fetchCalls, 2);
});
