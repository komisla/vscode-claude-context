import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_LIMIT_ERROR_RETRY_MS,
  RateLimitReader,
  type RateLimitFetch,
  type RateLimitFetchInit
} from '../dataSource/rateLimit';

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
  const requestedBody = JSON.parse(requestedInit?.body ?? '{}') as { readonly model?: string };
  assert.equal(requestedBody.model, 'claude-haiku-4-5-20251001');
  assert.notEqual(requestedInit?.signal, undefined);
  assert.equal(requestedInit?.signal?.aborted, false);
});

test('RateLimitReader retries with fallback probe model after 404', async () => {
  const requestedModels: string[] = [];
  const reader = new RateLimitReader({
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as { readonly model?: string };

      if (body.model !== undefined) {
        requestedModels.push(body.model);
      }

      if (requestedModels.length === 1) {
        return { status: 404, headers: new TestHeaders({}) };
      }

      return {
        status: 200,
        headers: new TestHeaders({
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-7d-utilization': '0.2'
        })
      };
    }
  });

  const snapshot = await reader.refresh(NOW);

  assert.deepEqual(requestedModels, ['claude-haiku-4-5-20251001', 'claude-haiku-4-5']);
  assert.deepEqual(snapshot, {
    pct5h: 10,
    pct7d: 20,
    reset5h: undefined,
    reset7d: undefined
  });
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

test('RateLimitReader warns once when the API response is unauthorized', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const reader = new RateLimitReader({
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
      fetch: async () => ({ status: 401, headers: new TestHeaders({}) })
    });

    await reader.refresh(NOW);
    await reader.refresh(NOW + 5 * 60_000);

    assert.deepEqual(warnings, [
      [
        'claude-context: rate-limit probe returned 401 — OAuth token may have expired. Try signing in to Claude Code again.'
      ]
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test('RateLimitReader warns for forbidden API responses', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const reader = new RateLimitReader({
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
      fetch: async () => ({ status: 403, headers: new TestHeaders({}) })
    });

    await reader.refresh(NOW);

    assert.deepEqual(warnings, [
      [
        'claude-context: rate-limit probe returned 403 — OAuth token may have expired. Try signing in to Claude Code again.'
      ]
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test('RateLimitReader stays silent for transient rate-limit probe failures', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    let shouldThrow = true;
    const reader = new RateLimitReader({
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
      fetch: async () => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('network unavailable');
        }

        return { status: 500, headers: new TestHeaders({}) };
      }
    });

    await reader.refresh(NOW);
    await reader.refresh(NOW + 5 * 60_000);

    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
  }
});

test('RateLimitReader retries transient probe failures after the short error TTL', async () => {
  let fetchCalls = 0;
  const reader = new RateLimitReader({
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } }),
    fetch: async () => {
      fetchCalls += 1;

      if (fetchCalls === 1) {
        throw new Error('network unavailable');
      }

      return {
        headers: new TestHeaders({
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-7d-utilization': '0.3'
        })
      };
    }
  });

  assert.equal(await reader.refresh(NOW), undefined);

  assert.equal(await reader.refresh(NOW + RATE_LIMIT_ERROR_RETRY_MS - 1), undefined);
  assert.equal(fetchCalls, 1);

  assert.deepEqual(await reader.refresh(NOW + RATE_LIMIT_ERROR_RETRY_MS), {
    pct5h: 20,
    pct7d: 30,
    reset5h: undefined,
    reset7d: undefined
  });
  assert.equal(fetchCalls, 2);
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
