import { Buffer } from 'buffer';
import { createReadStream, promises as fsp } from 'fs';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import { isAssistantTurn, normalizeModel } from './jsonlTail';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

// Claude projects layout: <projectsRoot>/<slug>/<session>.jsonl (depth 2).
// Allow one extra level for future sub-directories.
const MAX_PROJECTS_SCAN_DEPTH = 3;

export interface ModelUsage {
  readonly tokens5h: number;
  readonly tokens7d: number;
}

export interface HistoricalUsageSnapshot {
  readonly tokens5h: number;
  readonly tokens7d: number;
  readonly hasData: boolean;
  readonly byModel: ReadonlyMap<string, ModelUsage>;
}

interface TokenEntry {
  readonly timestampMs: number;
  readonly tokens: number;
  readonly model: string;
}

interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly entries: readonly TokenEntry[];
}

interface CachedDirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
}

interface CachedDirectory {
  readonly mtimeMs: number;
  readonly entries: readonly CachedDirectoryEntry[];
}

interface TailChunkRead {
  readonly entries: readonly TokenEntry[];
  readonly bytesRead: number;
  readonly remainder: string;
}

export class HistoricalUsageReader {
  private readonly cache = new Map<string, CachedFile>();
  private readonly fileOffsets = new Map<string, number>();
  private readonly fileRemainders = new Map<string, string>();
  private readonly directoryCache = new Map<string, CachedDirectory>();
  private inFlight: Promise<HistoricalUsageSnapshot> | undefined;

  public constructor(private readonly projectsRoot = path.join(os.homedir(), '.claude', 'projects')) {}

  public async refresh(nowMs = Date.now()): Promise<HistoricalUsageSnapshot> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    this.inFlight = this.doRefresh(nowMs).finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  public calculateSnapshot(nowMs = Date.now()): HistoricalUsageSnapshot {
    const min5h = nowMs - FIVE_HOURS_MS;
    const min7d = nowMs - SEVEN_DAYS_MS;
    let tokens5h = 0;
    let tokens7d = 0;
    let hasData = false;
    const byModel = new Map<string, { tokens5h: number; tokens7d: number }>();

    for (const cached of this.cache.values()) {
      for (const entry of cached.entries) {
        hasData = true;

        if (entry.timestampMs >= min7d) {
          tokens7d += entry.tokens;
          getModelUsage(byModel, entry.model).tokens7d += entry.tokens;
        }

        if (entry.timestampMs >= min5h) {
          tokens5h += entry.tokens;
          getModelUsage(byModel, entry.model).tokens5h += entry.tokens;
        }
      }
    }

    return {
      tokens5h,
      tokens7d,
      hasData,
      byModel
    };
  }

  private async refreshFile(jsonlPath: string, nowMs: number): Promise<void> {
    let stats;

    try {
      stats = await fsp.stat(jsonlPath);
    } catch {
      this.cache.delete(jsonlPath);
      this.fileOffsets.delete(jsonlPath);
      this.fileRemainders.delete(jsonlPath);
      return;
    }

    const cached = this.cache.get(jsonlPath);
    const minTimestamp = nowMs - SEVEN_DAYS_MS;
    const previousOffset = this.fileOffsets.get(jsonlPath) ?? 0;
    const truncated = cached !== undefined && stats.size < previousOffset;

    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      if (cached.entries.some((e) => e.timestampMs < minTimestamp)) {
        this.cache.set(jsonlPath, { ...cached, entries: cached.entries.filter((e) => e.timestampMs >= minTimestamp) });
      }
      return;
    }

    if (cached === undefined || truncated) {
      let entries: TokenEntry[];

      try {
        entries = await this.readEntireFile(jsonlPath, minTimestamp);
      } catch {
        this.cache.delete(jsonlPath);
        this.fileOffsets.delete(jsonlPath);
        this.fileRemainders.delete(jsonlPath);
        return;
      }

      this.cache.set(jsonlPath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        entries
      });
      this.fileOffsets.set(jsonlPath, stats.size);
      this.fileRemainders.delete(jsonlPath);
      return;
    }

    if (stats.size === previousOffset) {
      return;
    }

    const currentRemainder = this.fileRemainders.get(jsonlPath) ?? '';
    let appended: TailChunkRead;

    try {
      appended = await this.readTailChunk(jsonlPath, previousOffset, currentRemainder, stats.size, minTimestamp);
    } catch {
      this.cache.delete(jsonlPath);
      this.fileOffsets.delete(jsonlPath);
      this.fileRemainders.delete(jsonlPath);
      return;
    }

    const entries = [...cached.entries, ...appended.entries].filter((entry) => entry.timestampMs >= minTimestamp);

    this.cache.set(jsonlPath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      entries
    });
    this.fileOffsets.set(jsonlPath, previousOffset + appended.bytesRead);
    if (appended.remainder === '') {
      this.fileRemainders.delete(jsonlPath);
    } else {
      this.fileRemainders.set(jsonlPath, appended.remainder);
    }
  }

  private async doRefresh(nowMs: number): Promise<HistoricalUsageSnapshot> {
    const visitedDirectories = new Set<string>();
    const jsonlPaths = await this.findJsonlFiles(this.projectsRoot, 0, visitedDirectories);
    const existingPaths = new Set(jsonlPaths);

    for (const cachedPath of this.cache.keys()) {
      if (!existingPaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
      }
    }

    for (const cachedDirectory of this.directoryCache.keys()) {
      if (!visitedDirectories.has(cachedDirectory)) {
        this.directoryCache.delete(cachedDirectory);
      }
    }

    for (const jsonlPath of jsonlPaths) {
      await this.refreshFile(jsonlPath, nowMs);
    }

    return this.calculateSnapshot(nowMs);
  }

  private async findJsonlFiles(
    dir: string,
    depth = 0,
    visitedDirectories = new Set<string>()
  ): Promise<string[]> {
    if (depth > MAX_PROJECTS_SCAN_DEPTH) {
      return [];
    }

    visitedDirectories.add(dir);

    try {
      const stats = await fsp.stat(dir);
      const cached = this.directoryCache.get(dir);

      if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) {
        const files: string[] = [];
        const subdirPromises: Array<Promise<string[]>> = [];

        for (const entry of cached.entries) {
          if (entry.kind === 'symlink') {
            continue;
          }

          const entryPath = path.join(dir, entry.name);

          if (entry.kind === 'directory') {
            subdirPromises.push(this.findJsonlFiles(entryPath, depth + 1, visitedDirectories));
          } else if (entry.name.endsWith('.jsonl')) {
            files.push(entryPath);
          }
        }

        const subdirResults = await Promise.all(subdirPromises);

        for (const subdirFiles of subdirResults) {
          files.push(...subdirFiles);
        }

        return files;
      }

      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const cachedEntries = entries.map((entry) => {
        if (entry.isDirectory()) {
          return { name: entry.name, kind: 'directory' as const };
        }

        if (entry.isSymbolicLink()) {
          return { name: entry.name, kind: 'symlink' as const };
        }

        return { name: entry.name, kind: 'file' as const };
      });

      this.directoryCache.set(dir, {
        mtimeMs: stats.mtimeMs,
        entries: cachedEntries
      });

      const files: string[] = [];
      const subdirPromises: Array<Promise<string[]>> = [];

      for (const entry of cachedEntries) {
        if (entry.kind === 'symlink') {
          continue;
        }

        const entryPath = path.join(dir, entry.name);

        if (entry.kind === 'directory') {
          subdirPromises.push(this.findJsonlFiles(entryPath, depth + 1, visitedDirectories));
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(entryPath);
        }
      }

      const subdirResults = await Promise.all(subdirPromises);

      for (const subdirFiles of subdirResults) {
        files.push(...subdirFiles);
      }

      return files;
    } catch {
      this.directoryCache.delete(dir);
      return [];
    }
  }

  private async readEntireFile(jsonlPath: string, minTimestamp: number): Promise<TokenEntry[]> {
    const entries: TokenEntry[] = [];

    const rl = createInterface({
      input: createReadStream(jsonlPath, 'utf8'),
      crlfDelay: Infinity
    });

    for await (const lineText of rl) {
      const entry = parseHistoricalUsageLine(lineText);
      if (entry !== undefined && entry.timestampMs >= minTimestamp) {
        entries.push(entry);
      }
    }

    return entries;
  }

  private async readTailChunk(
    jsonlPath: string,
    offset: number,
    remainder: string,
    size: number,
    minTimestamp: number
  ): Promise<TailChunkRead> {
    const handle = await fsp.open(jsonlPath, 'r');

    try {
      const length = size - offset;

      if (length <= 0) {
        return { entries: [], bytesRead: 0, remainder };
      }

      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const combined = `${remainder}${buffer.subarray(0, bytesRead).toString('utf8')}`;
      const complete = combined.endsWith('\n');
      const lines = combined.split(/\r?\n/);
      const completeLines = complete ? lines : lines.slice(0, -1);
      const nextRemainder = complete ? '' : lines.at(-1) ?? '';
      const entries: TokenEntry[] = [];

      for (const line of completeLines) {
        if (line.trim() === '') {
          continue;
        }

        const entry = parseHistoricalUsageLine(line);
        if (entry !== undefined && entry.timestampMs >= minTimestamp) {
          entries.push(entry);
        }
      }

      return {
        entries,
        bytesRead,
        remainder: nextRemainder
      };
    } finally {
      await handle.close();
    }
  }
}

export function parseHistoricalUsageLine(lineText: string): TokenEntry | undefined {
  if (lineText.trim() === '') {
    return undefined;
  }

  let line: unknown;

  try {
    line = JSON.parse(lineText) as unknown;
  } catch {
    return undefined;
  }

  if (!isAssistantTurn(line) || !isRecord(line) || !isRecord(line.message)) {
    return undefined;
  }

  if (typeof line.timestamp !== 'string') {
    return undefined;
  }

  const timestampMs = Date.parse(line.timestamp);

  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }

  return {
    timestampMs,
    tokens: getHistoricalBudgetTokens(line.message.usage),
    model: normalizeModel(line.message)
  };
}

function getHistoricalBudgetTokens(usage: unknown): number {
  if (!isRecord(usage)) {
    return 0;
  }

  return (
    numberValue(usage.input_tokens) +
    numberValue(usage.cache_creation_input_tokens) +
    numberValue(usage.output_tokens)
  );
}

function getModelUsage(
  byModel: Map<string, { tokens5h: number; tokens7d: number }>,
  model: string
): { tokens5h: number; tokens7d: number } {
  const existing = byModel.get(model);

  if (existing !== undefined) {
    return existing;
  }

  const usage = { tokens5h: 0, tokens7d: 0 };
  byModel.set(model, usage);
  return usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
