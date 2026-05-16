import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUsageTotal, isAssistantTurn } from './jsonlTail';

export const DEFAULT_BUDGET_5H = 5_000_000;
export const DEFAULT_BUDGET_7D = 50_000_000;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export interface HistoricalUsageBudgets {
  readonly budget5h: number;
  readonly budget7d: number;
}

export interface ModelUsage {
  readonly tokens5h: number;
  readonly tokens7d: number;
}

export interface HistoricalUsageSnapshot {
  readonly tokens5h: number;
  readonly tokens7d: number;
  readonly pct5h: number;
  readonly pct7d: number;
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

export class HistoricalUsageReader {
  private readonly cache = new Map<string, CachedFile>();

  public constructor(private readonly projectsRoot = path.join(os.homedir(), '.claude', 'projects')) {}

  public async refresh(
    budgets: HistoricalUsageBudgets,
    nowMs = Date.now()
  ): Promise<HistoricalUsageSnapshot> {
    const jsonlPaths = await this.findJsonlFiles(this.projectsRoot);
    const existingPaths = new Set(jsonlPaths);

    for (const cachedPath of this.cache.keys()) {
      if (!existingPaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
      }
    }

    for (const jsonlPath of jsonlPaths) {
      await this.refreshFile(jsonlPath, nowMs);
    }

    return this.calculateSnapshot(budgets, nowMs);
  }

  public calculateSnapshot(
    budgets: HistoricalUsageBudgets,
    nowMs = Date.now()
  ): HistoricalUsageSnapshot {
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
      pct5h: calculateBudgetPercent(tokens5h, budgets.budget5h),
      pct7d: calculateBudgetPercent(tokens7d, budgets.budget7d),
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
      return;
    }

    const cached = this.cache.get(jsonlPath);

    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return;
    }

    let raw: string;

    try {
      raw = await fsp.readFile(jsonlPath, 'utf8');
    } catch {
      this.cache.delete(jsonlPath);
      return;
    }

    const minTimestamp = nowMs - SEVEN_DAYS_MS;
    const entries = raw
      .split(/\r?\n/)
      .map(parseHistoricalUsageLine)
      .filter((entry): entry is TokenEntry => entry !== undefined && entry.timestampMs >= minTimestamp);

    this.cache.set(jsonlPath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      entries
    });
  }

  private async findJsonlFiles(dir: string): Promise<string[]> {
    let entries;

    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await this.findJsonlFiles(entryPath)));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }

    return files;
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
    tokens: getUsageTotal(line.message.usage),
    model: normalizeModel(line.message.model)
  };
}

function normalizeModel(model: unknown): string {
  return typeof model === 'string' && model.trim() !== '' ? model : 'unknown';
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

function calculateBudgetPercent(tokens: number, budget: number): number {
  if (!Number.isFinite(budget) || budget <= 0) {
    return 0;
  }

  return Math.min((tokens / budget) * 100, 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
