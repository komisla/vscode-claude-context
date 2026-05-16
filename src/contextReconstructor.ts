import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encode } from 'gpt-tokenizer';
import type { ContextUpdate } from './dataSource';

export const CC_BASE_SYSTEM_PROMPT_TOKENS = 8_000; // measured on CC v2.1.143, 2026-05-16
export const TOKENS_PER_BUILTIN_TOOL = 300;
export const TOKENS_PER_MCP_TOOL = 400;
export const BREAKDOWN_CACHE_MS = 30_000;

export interface ContextBreakdownCategories {
  readonly systemPrompt: number;
  readonly claudeMd: number;
  readonly memory: number;
  readonly tools: number;
  readonly conversation: number;
}

export interface ContextBreakdown {
  readonly totalTokens: number;
  readonly effectiveWindow: number;
  readonly fillPercent: number;
  readonly categories: ContextBreakdownCategories;
  readonly systemPromptDriftWarning: boolean;
  readonly isEstimate: true;
  readonly measuredAt: Date;
}

export interface ReconstructContextBreakdownOptions {
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly key: string;
  readonly expiresAt: number;
  readonly value: ContextBreakdown;
}

interface DeferredToolsDeltaLine {
  readonly attachment: {
    readonly addedNames?: unknown;
    readonly removedNames?: unknown;
    readonly readdedNames?: unknown;
  };
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ContextBreakdown>>();

export function countTokens(text: string): number {
  return encode(text).length;
}

export function clearContextBreakdownCache(): void {
  cache.clear();
  inFlight.clear();
}

export async function reconstructContextBreakdown(
  source: ContextUpdate,
  options: ReconstructContextBreakdownOptions = {}
): Promise<ContextBreakdown> {
  const now = options.now?.() ?? Date.now();
  const key = getCacheKey(source, options.workspaceRoot, options.homeDir);
  const totalTokens = source.totalTokens;
  const cached = cache.get(key);

  if (cached !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  if (totalTokens === undefined) {
    const emptyBreakdown = createBreakdown(source, {
      systemPrompt: 0,
      claudeMd: 0,
      memory: 0,
      tools: 0,
      conversation: 0
    }, now);

    cache.set(key, {
      key,
      expiresAt: now + BREAKDOWN_CACHE_MS,
      value: emptyBreakdown
    });

    return emptyBreakdown;
  }

  const pending = inFlight.get(key);

  if (pending !== undefined) {
    return pending;
  }

  const promise = (async () => {
    const systemPrompt = CC_BASE_SYSTEM_PROMPT_TOKENS;
    const claudeMd = await countClaudeMdTokens(options.workspaceRoot, options.homeDir);
    const memory = await countMemoryTokens(source.sessionPath);
    const tools = await estimateToolTokens(source.sessionPath);
    const conversation = Math.max(0, totalTokens - systemPrompt - claudeMd - memory - tools);
    const breakdown = createBreakdown(
      source,
      {
        systemPrompt,
        claudeMd,
        memory,
        tools,
        conversation
      },
      now,
      conversation === 0 && totalTokens > 0
    );

    cache.set(key, {
      key,
      expiresAt: now + BREAKDOWN_CACHE_MS,
      value: breakdown
    });

    return breakdown;
  })();

  inFlight.set(key, promise);

  try {
    return await promise;
  } finally {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  }
}

function createBreakdown(
  source: ContextUpdate,
  categories: ContextBreakdownCategories,
  measuredAtMs: number,
  systemPromptDriftWarning = false
): ContextBreakdown {
  return {
    totalTokens: source.totalTokens ?? 0,
    effectiveWindow: source.effectiveWindow ?? source.contextWindow ?? 0,
    fillPercent: source.fillPercent ?? 0,
    categories,
    systemPromptDriftWarning,
    isEstimate: true,
    measuredAt: new Date(measuredAtMs)
  };
}

export async function countClaudeMdTokens(
  workspaceRoot: string | undefined,
  homeDir = os.homedir()
): Promise<number> {
  const claudeMdPaths = new Set<string>();

  if (workspaceRoot !== undefined) {
    for (const filePath of getClaudeMdPathsUpTree(workspaceRoot)) {
      claudeMdPaths.add(filePath);
    }
  }

  claudeMdPaths.add(path.join(homeDir, '.claude', 'CLAUDE.md'));

  let total = 0;

  for (const filePath of claudeMdPaths) {
    const content = await readTextFile(filePath);

    if (content === undefined) {
      continue;
    }

    total += countTokens(content);
    total += await countImportedClaudeMdTokens(
      content,
      filePath,
      homeDir,
      new Set([path.resolve(filePath)])
    );
  }

  return total;
}

export async function countMemoryTokens(sessionPath: string | undefined): Promise<number> {
  if (sessionPath === undefined) {
    return 0;
  }

  const memoryDir = path.join(path.dirname(sessionPath), 'memory');
  let entries: import('fs').Dirent[];

  try {
    entries = await fsp.readdir(memoryDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const content = await readTextFile(path.join(memoryDir, entry.name));
    total += content === undefined ? 0 : countTokens(content);
  }

  return total;
}

export async function estimateToolTokens(sessionPath: string | undefined): Promise<number> {
  if (sessionPath === undefined) {
    return 0;
  }

  const content = await readTextFile(sessionPath);

  if (content === undefined) {
    return 0;
  }

  const activeTools = replayDeferredTools(content);
  let total = 0;

  for (const toolName of activeTools) {
    total += isMcpToolName(toolName) ? TOKENS_PER_MCP_TOOL : TOKENS_PER_BUILTIN_TOOL;
  }

  return total;
}

export function replayDeferredTools(jsonl: string): ReadonlySet<string> {
  const activeTools = new Set<string>();

  for (const lineText of jsonl.split(/\r?\n/)) {
    if (lineText.trim() === '') {
      continue;
    }

    let line: unknown;

    try {
      line = JSON.parse(lineText) as unknown;
    } catch {
      continue;
    }

    if (isRecord(line) && line.isSidechain === true) {
      continue;
    }

    if (!isDeferredToolsDelta(line)) {
      continue;
    }

    for (const name of getStringArray(line.attachment.addedNames)) {
      activeTools.add(name);
    }

    for (const name of getStringArray(line.attachment.removedNames)) {
      activeTools.delete(name);
    }

    for (const name of getStringArray(line.attachment.readdedNames)) {
      activeTools.add(name);
    }
  }

  return activeTools;
}

export function isDeferredToolsDelta(line: unknown): line is DeferredToolsDeltaLine {
  return (
    isRecord(line) &&
    line.type === 'attachment' &&
    isRecord(line.attachment) &&
    line.attachment.type === 'deferred_tools_delta'
  );
}

export function isMcpToolName(toolName: string): boolean {
  return toolName.includes('__');
}

function getCacheKey(
  source: ContextUpdate,
  workspaceRoot: string | undefined,
  homeDir: string | undefined
): string {
  return [
    source.sessionPath,
    source.totalTokens,
    source.effectiveWindow,
    source.fillPercent,
    workspaceRoot,
    homeDir
  ]
    .map(String)
    .join('|');
}

function getClaudeMdPathsUpTree(workspaceRoot: string): readonly string[] {
  const paths: string[] = [];
  let current = path.resolve(workspaceRoot);

  while (true) {
    paths.push(path.join(current, 'CLAUDE.md'));

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return paths;
}

async function countImportedClaudeMdTokens(
  content: string,
  sourcePath: string,
  homeDir: string,
  visited: Set<string>
): Promise<number> {
  let total = 0;
  const sourceDir = path.dirname(sourcePath);

  for (const importPath of extractAtImports(content)) {
    const resolvedPath = resolveImportPath(importPath, sourceDir, homeDir);

    if (resolvedPath === undefined) {
      continue;
    }

    const normalizedPath = path.resolve(resolvedPath);

    if (visited.has(normalizedPath)) {
      continue;
    }

    const importedContent = await readTextFile(normalizedPath);

    if (importedContent === undefined) {
      continue;
    }

    visited.add(normalizedPath);
    total += countTokens(importedContent);
    total += await countImportedClaudeMdTokens(
      importedContent,
      normalizedPath,
      homeDir,
      visited
    );
  }

  return total;
}

function extractAtImports(content: string): readonly string[] {
  const imports: string[] = [];
  const regex = /(?:^|\s)@([^\s@]+)/g;
  let match = regex.exec(content);

  while (match !== null) {
    const importPath = cleanImportPath(match[1]);

    if (
      importPath !== '' &&
      !importPath.includes('://') &&
      (importPath.startsWith('./') ||
        importPath.startsWith('../') ||
        importPath.startsWith('~/') ||
        importPath.startsWith('/'))
    ) {
      imports.push(importPath);
    }

    match = regex.exec(content);
  }

  return imports;
}

function cleanImportPath(importPath: string): string {
  return importPath.trim().replace(/[),.;:!?]+$/g, '');
}

function resolveImportPath(
  importPath: string,
  sourceDir: string,
  homeDir: string
): string | undefined {
  if (importPath.startsWith('~')) {
    return path.join(homeDir, importPath.slice(1));
  }

  if (path.isAbsolute(importPath)) {
    return importPath;
  }

  return path.resolve(sourceDir, importPath);
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function getStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
