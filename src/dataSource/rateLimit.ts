import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearTimeout, setTimeout } from 'timers';

export const RATE_LIMIT_REFRESH_MS = 5 * 60 * 1_000;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const RATE_LIMIT_FETCH_TIMEOUT_MS = 8_000;
const RATE_LIMIT_5H_HEADER = 'anthropic-ratelimit-unified-5h-utilization';
const RATE_LIMIT_7D_HEADER = 'anthropic-ratelimit-unified-7d-utilization';
const RATE_LIMIT_5H_RESET_HEADER = 'anthropic-ratelimit-unified-5h-reset';
const RATE_LIMIT_7D_RESET_HEADER = 'anthropic-ratelimit-unified-7d-reset';
// Cheapest model for the one-token probe. Update when Anthropic retires this model ID.
const RATE_LIMIT_PROBE_MODEL = 'claude-haiku-4-5-20251001';

export interface RateLimitSnapshot {
  readonly pct5h: number;
  readonly pct7d: number;
  readonly reset5h?: string;
  readonly reset7d?: string;
}

export interface RateLimitFetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: InstanceType<typeof globalThis.AbortController>['signal'];
}

export interface RateLimitFetchResponse {
  readonly headers: {
    get(name: string): string | null;
  };
}

export type RateLimitFetch = (
  url: string,
  init: RateLimitFetchInit
) => Promise<RateLimitFetchResponse>;

interface CredentialsFile {
  readonly claudeAiOauth?: {
    readonly accessToken?: unknown;
  };
}

interface RateLimitReaderOptions {
  readonly credentialsPath?: string;
  readonly fetch?: RateLimitFetch;
  readonly fetchTimeoutMs?: number;
  readonly readFile?: (filePath: string, encoding: 'utf-8') => Promise<string>;
}

export class RateLimitReader {
  private readonly credentialsPath: string;
  private readonly fetcher: RateLimitFetch | undefined;
  private readonly fetchTimeoutMs: number;
  private readonly readFile: (filePath: string, encoding: 'utf-8') => Promise<string>;
  private cached: RateLimitSnapshot | undefined;
  private cachedAtMs = 0;
  private inFlight: Promise<RateLimitSnapshot | undefined> | undefined;

  public constructor(options: RateLimitReaderOptions = {}) {
    this.credentialsPath =
      options.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json');
    this.fetcher = options.fetch ?? getDefaultFetch();
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? RATE_LIMIT_FETCH_TIMEOUT_MS;
    this.readFile = options.readFile ?? fsp.readFile;
  }

  public async refresh(nowMs = Date.now()): Promise<RateLimitSnapshot | undefined> {
    if (this.cachedAtMs !== 0 && nowMs - this.cachedAtMs < RATE_LIMIT_REFRESH_MS) {
      return this.cached;
    }

    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    this.inFlight = this.doRefresh(nowMs).finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  private async doRefresh(nowMs: number): Promise<RateLimitSnapshot | undefined> {
    try {
      const token = await this.readAccessToken();

      if (token === undefined || this.fetcher === undefined) {
        return this.cache(undefined, nowMs);
      }

      const controller = new globalThis.AbortController();
      const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

      try {
        const response = await this.fetcher(ANTHROPIC_MESSAGES_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: RATE_LIMIT_PROBE_MODEL,
            max_tokens: 1,
            messages: [{ role: 'user', content: '.' }]
          }),
          signal: controller.signal
        });

        return this.cache(readRateLimitSnapshot(response.headers), nowMs);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return this.cache(undefined, nowMs);
    }
  }

  private cache(snapshot: RateLimitSnapshot | undefined, nowMs: number): RateLimitSnapshot | undefined {
    this.cached = snapshot;
    this.cachedAtMs = nowMs;
    return snapshot;
  }

  private async readAccessToken(): Promise<string | undefined> {
    let content: string;

    try {
      content = await this.readFile(this.credentialsPath, 'utf-8');
    } catch {
      return undefined;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(content) as CredentialsFile;
    } catch {
      return undefined;
    }

    if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) {
      return undefined;
    }

    const token = parsed.claudeAiOauth.accessToken;
    return typeof token === 'string' && token.trim() !== '' ? token : undefined;
  }
}

function readRateLimitSnapshot(headers: RateLimitFetchResponse['headers']): RateLimitSnapshot | undefined {
  const pct5h = parseUtilizationHeader(headers.get(RATE_LIMIT_5H_HEADER));
  const pct7d = parseUtilizationHeader(headers.get(RATE_LIMIT_7D_HEADER));

  if (pct5h === undefined || pct7d === undefined) {
    return undefined;
  }

  return {
    pct5h,
    pct7d,
    reset5h: parseResetHeader(headers.get(RATE_LIMIT_5H_RESET_HEADER)),
    reset7d: parseResetHeader(headers.get(RATE_LIMIT_7D_RESET_HEADER))
  };
}

function parseUtilizationHeader(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.min(Math.max(parsed * 100, 0), 100);
}

function parseResetHeader(value: string | null): string | undefined {
  if (value === null || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }

  return value;
}

function getDefaultFetch(): RateLimitFetch | undefined {
  const maybeFetch = (globalThis as { readonly fetch?: unknown }).fetch;

  if (typeof maybeFetch !== 'function') {
    return undefined;
  }

  return (url, init) => maybeFetch(url, init) as Promise<RateLimitFetchResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
