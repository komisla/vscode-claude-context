import { promises as fsp } from 'fs';
import { Buffer } from 'buffer';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { encode } from 'gpt-tokenizer';
import type { ContextUpdate } from './dataSource';

export const CC_BASE_SYSTEM_PROMPT_TOKENS = 8_000; // measured on CC v2.1.143, 2026-05-16
export const TOKENS_PER_BUILTIN_TOOL = 300;
export const TOKENS_PER_MCP_TOOL = 400;
export const BREAKDOWN_CACHE_MS = 30_000;
export const BREAKDOWN_TOTAL_TOKEN_BUCKET_SIZE = 5_000;
const MIN_TOKENS_FOR_DRIFT_WARNING = 20_000;
const CONTEXT_BREAKDOWN_PRUNE_INTERVAL_MS = 60_000;
const CLAUDE_MD_MISSING_FINGERPRINT_TTL_MS = 5_000;
const MAX_IMPORTED_CLAUDE_MD_DEPTH = 10;
const CACHE_KEY_SEPARATOR = '\0';
const TOOL_CACHE_SUFFIX_BYTES = 64;

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
  readonly contextWindow?: number;
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

interface CachedTextFile {
  readonly fingerprint: string;
  readonly content: string;
  readonly tokenCount: number;
}

interface CachedToolSet {
  readonly mtimeMs: number;
  readonly offset: number;
  readonly remainder: string;
  readonly suffix: Buffer;
  readonly tools: ReadonlySet<string>;
}

interface MissingFingerprintEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ContextBreakdown>>();
const textFileCache = new Map<string, CachedTextFile>();
const toolSetCache = new Map<string, CachedToolSet>();
const claudeMdPathTreeCache = new Map<string, readonly string[]>();
const missingFingerprintCache = new Map<string, MissingFingerprintEntry>();
let lastContextBreakdownPruneAt = 0;

export function countTokens(text: string): number {
  return encode(text).length;
}

export function clearAllContextCaches(): void {
  cache.clear();
  inFlight.clear();
  textFileCache.clear();
  toolSetCache.clear();
  claudeMdPathTreeCache.clear();
  missingFingerprintCache.clear();
  lastContextBreakdownPruneAt = 0;
}

export async function reconstructContextBreakdown(
  source: ContextUpdate,
  options: ReconstructContextBreakdownOptions = {}
): Promise<ContextBreakdown> {
  const now = options.now?.() ?? Date.now();
  const homeDir = options.homeDir ?? os.homedir();
  const key = await getCacheKey(source, options.workspaceRoot, homeDir, now);
  const totalTokens = source.totalTokens;
  const cached = cache.get(key);

  if (cached !== undefined && cached.expiresAt > now) {
    maybePruneExpiredContextBreakdownCache(now);
    return refreshCachedBreakdown(cached.value, source, now);
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
    maybePruneExpiredContextBreakdownCache(now);

    return emptyBreakdown;
  }

  const pending = inFlight.get(key);

  if (pending !== undefined) {
    return pending;
  }

  const promise = (async () => {
    const systemPrompt = CC_BASE_SYSTEM_PROMPT_TOKENS;
    const claudeMd = await countClaudeMdTokens(options.workspaceRoot, homeDir, now);
    const memory = await countMemoryTokens(source.sessionPath, now);
    const tools = await estimateToolTokens(source.sessionPath, now);
    const nonConversationTokens = systemPrompt + claudeMd + memory + tools;
    const conversation = Math.max(0, totalTokens - nonConversationTokens);
    const systemPromptDriftWarning =
      nonConversationTokens > totalTokens ||
      (conversation === 0 && totalTokens >= MIN_TOKENS_FOR_DRIFT_WARNING);
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
      systemPromptDriftWarning
    );

    cache.set(key, {
      key,
      expiresAt: now + BREAKDOWN_CACHE_MS,
      value: breakdown
    });
    maybePruneExpiredContextBreakdownCache(now);

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
    contextWindow: source.contextWindow,
    fillPercent: source.fillPercent ?? 0,
    categories,
    systemPromptDriftWarning,
    isEstimate: true,
    measuredAt: new Date(measuredAtMs)
  };
}

function refreshCachedBreakdown(
  cached: ContextBreakdown,
  source: ContextUpdate,
  measuredAtMs: number
): ContextBreakdown {
  const totalTokens = source.totalTokens ?? 0;
  const fixedCategories = {
    systemPrompt: cached.categories.systemPrompt,
    claudeMd: cached.categories.claudeMd,
    memory: cached.categories.memory,
    tools: cached.categories.tools
  };
  const nonConversationTokens =
    fixedCategories.systemPrompt +
    fixedCategories.claudeMd +
    fixedCategories.memory +
    fixedCategories.tools;
  const conversation = Math.max(0, totalTokens - nonConversationTokens);

  return createBreakdown(
    source,
    {
      ...fixedCategories,
      conversation
    },
    measuredAtMs,
    nonConversationTokens > totalTokens ||
      (conversation === 0 && totalTokens >= MIN_TOKENS_FOR_DRIFT_WARNING)
  );
}

export async function countClaudeMdTokens(
  workspaceRoot: string | undefined,
  homeDir = os.homedir(),
  now = Date.now()
): Promise<number> {
  const claudeMdPaths = new Set<string>();

  if (workspaceRoot !== undefined) {
    for (const filePath of getClaudeMdPathsUpTreeCached(workspaceRoot)) {
      claudeMdPaths.add(filePath);
    }
  }

  claudeMdPaths.add(path.join(homeDir, '.claude', 'CLAUDE.md'));

  const claudeMdFiles = await Promise.all(
    Array.from(claudeMdPaths).map(async (filePath) => ({
      filePath,
      snapshot: await readCachedTextFile(filePath, now)
    }))
  );

  let total = 0;

  for (const { filePath, snapshot } of claudeMdFiles) {
    if (snapshot === undefined) {
      continue;
    }

    total += snapshot.tokenCount;
    total += await countImportedClaudeMdTokens(
      snapshot.content,
      filePath,
      workspaceRoot,
      homeDir,
      now,
      new Set([path.resolve(filePath)])
    );
  }

  return total;
}

export async function countMemoryTokens(
  sessionPath: string | undefined,
  now = Date.now()
): Promise<number> {
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

  const memoryFiles = await Promise.all(
    entries.flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        return [];
      }

      const filePath = path.join(memoryDir, entry.name);
      return [
        (async () => ({
          filePath,
          snapshot: await readCachedTextFile(filePath, now)
        }))()
      ];
    })
  );

  let total = 0;

  for (const { snapshot } of memoryFiles) {
    if (snapshot === undefined) {
      continue;
    }

    total += snapshot.tokenCount;
  }

  return total;
}

export async function estimateToolTokens(sessionPath: string | undefined, now = Date.now()): Promise<number> {
  if (sessionPath === undefined) {
    return 0;
  }

  const activeTools = await readDeferredToolsFromSession(sessionPath, now);

  if (activeTools === undefined) {
    return 0;
  }

  let total = 0;

  for (const toolName of activeTools) {
    total += isMcpToolName(toolName) ? TOKENS_PER_MCP_TOOL : TOKENS_PER_BUILTIN_TOOL;
  }

  return total;
}

export function replayDeferredTools(jsonl: string): ReadonlySet<string> {
  const activeTools = new Set<string>();

  for (const lineText of jsonl.split(/\r?\n/)) {
    consumeDeferredToolLine(activeTools, lineText);
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

async function getCacheKey(
  source: ContextUpdate,
  workspaceRoot: string | undefined,
  homeDir: string,
  now: number
): Promise<string> {
  const parts = [
    source.sessionPath,
    getTotalTokenBucket(source.totalTokens),
    source.effectiveWindow,
    source.contextWindow,
    workspaceRoot,
    homeDir,
    await getSessionToolFingerprint(source.sessionPath, now),
    ...(await getClaudeMdFingerprint(workspaceRoot, homeDir, now)),
    ...(await getMemoryFingerprint(source.sessionPath, now))
  ];

  return parts.join(CACHE_KEY_SEPARATOR);
}

function getTotalTokenBucket(totalTokens: number | undefined): number | undefined {
  if (totalTokens === undefined) {
    return undefined;
  }

  return Math.floor(totalTokens / BREAKDOWN_TOTAL_TOKEN_BUCKET_SIZE) * BREAKDOWN_TOTAL_TOKEN_BUCKET_SIZE;
}

async function getSessionToolFingerprint(
  sessionPath: string | undefined,
  now: number
): Promise<string> {
  if (sessionPath === undefined) {
    return 'no-session';
  }

  const activeTools = await readDeferredToolsFromSession(sessionPath, now);

  if (activeTools === undefined) {
    return `${path.resolve(sessionPath)}:missing`;
  }

  return Array.from(activeTools).sort().join('\n');
}

async function getClaudeMdFingerprint(
  workspaceRoot: string | undefined,
  homeDir: string,
  now: number
): Promise<readonly string[]> {
  const claudeMdPaths = new Set<string>();

  if (workspaceRoot !== undefined) {
    for (const filePath of getClaudeMdPathsUpTreeCached(workspaceRoot)) {
      claudeMdPaths.add(filePath);
    }
  }

  claudeMdPaths.add(path.join(homeDir, '.claude', 'CLAUDE.md'));

  const fingerprints: string[] = [];

  for (const filePath of claudeMdPaths) {
    fingerprints.push(await fingerprintPath(filePath, now));
  }

  return fingerprints;
}

async function getMemoryFingerprint(
  sessionPath: string | undefined,
  now: number
): Promise<readonly string[]> {
  if (sessionPath === undefined) {
    return [];
  }

  const memoryDir = path.join(path.dirname(sessionPath), 'memory');
  let entries: import('fs').Dirent[];

  try {
    entries = await fsp.readdir(memoryDir, { withFileTypes: true });
  } catch {
    return [await fingerprintPath(memoryDir, now)];
  }

  const fingerprints: string[] = [];

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    fingerprints.push(await fingerprintPath(path.join(memoryDir, entry.name), now));
  }

  return fingerprints;
}

async function fingerprintPath(filePath: string, now: number): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const cached = missingFingerprintCache.get(resolvedPath);

  if (cached !== undefined && cached.expiresAt > now) {
    return cached.fingerprint;
  }

  try {
    const stats = await fsp.stat(filePath);
    missingFingerprintCache.delete(resolvedPath);
    return `${resolvedPath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    const fingerprint = `${resolvedPath}:missing`;
    missingFingerprintCache.set(resolvedPath, {
      fingerprint,
      expiresAt: now + CLAUDE_MD_MISSING_FINGERPRINT_TTL_MS
    });
    return fingerprint;
  }
}

function getClaudeMdPathsUpTree(workspaceRoot: string): readonly string[] {
  const paths: string[] = [];
  let current = path.resolve(workspaceRoot);

  for (let index = 0; index < 64; index += 1) {
    paths.push(path.join(current, 'CLAUDE.md'));

    const parent = path.dirname(current);

    if (parent === current) {
      return paths;
    }

    current = parent;
  }

  return paths;
}

function getClaudeMdPathsUpTreeCached(workspaceRoot: string): readonly string[] {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const cached = claudeMdPathTreeCache.get(resolvedWorkspaceRoot);

  if (cached !== undefined) {
    return cached;
  }

  const paths = getClaudeMdPathsUpTree(resolvedWorkspaceRoot);
  claudeMdPathTreeCache.set(resolvedWorkspaceRoot, paths);
  return paths;
}

async function countImportedClaudeMdTokens(
  content: string,
  sourcePath: string,
  workspaceRoot: string | undefined,
  homeDir: string,
  now: number,
  visited: Set<string>,
  depth = 1
): Promise<number> {
  if (depth > MAX_IMPORTED_CLAUDE_MD_DEPTH) {
    return 0;
  }

  let total = 0;
  const sourceDir = path.dirname(sourcePath);

  for (const importPath of extractAtImports(content)) {
    const resolvedPath = resolveImportPath(importPath, sourceDir, homeDir);

    if (resolvedPath === undefined) {
      continue;
    }

    const normalizedPath = path.resolve(resolvedPath);

    if (!isAllowedClaudeMdImport(normalizedPath, sourceDir, workspaceRoot, homeDir)) {
      continue;
    }

    if (visited.has(normalizedPath)) {
      continue;
    }

    const importedSnapshot = await readCachedTextFile(normalizedPath, now);

    if (importedSnapshot === undefined) {
      continue;
    }

    visited.add(normalizedPath);
    total += importedSnapshot.tokenCount;
    total += await countImportedClaudeMdTokens(
      importedSnapshot.content,
      normalizedPath,
      workspaceRoot,
      homeDir,
      now,
      visited,
      depth + 1
    );
  }

  return total;
}

export function extractAtImports(content: string): readonly string[] {
  const imports: string[] = [];
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^\n`]+`/g, ' ');

  for (let index = 0; index < stripped.length; index += 1) {
    if (stripped[index] !== '@') {
      continue;
    }

    if (index > 0 && !/\s/.test(stripped[index - 1])) {
      continue;
    }

    const importPath = readAtImportPath(stripped, index + 1);

    if (
      importPath !== '' &&
      !importPath.includes('://') &&
      (importPath.startsWith('./') ||
        importPath.startsWith('../') ||
        importPath.startsWith('~/'))
    ) {
      imports.push(importPath);
    }
  }

  return imports;
}

function readAtImportPath(content: string, startIndex: number): string {
  const firstChar = content[startIndex];

  if (firstChar === '"' || firstChar === "'") {
    const endIndex = content.indexOf(firstChar, startIndex + 1);

    if (endIndex === -1) {
      return '';
    }

    return cleanImportPath(content.slice(startIndex + 1, endIndex));
  }

  const lineEndIndex = content.indexOf('\n', startIndex);
  const nextAtIndex = content.indexOf('@', startIndex);
  const endIndex = [lineEndIndex, nextAtIndex]
    .filter((candidate) => candidate !== -1)
    .reduce((min, candidate) => Math.min(min, candidate), content.length);
  const candidate = content.slice(startIndex, endIndex);
  const markdownPathMatch = candidate.match(/^[\S ]+?\.md\b/i);

  if (markdownPathMatch !== null) {
    return cleanImportPath(markdownPathMatch[0]);
  }

  return cleanImportPath(candidate.split(/\s/, 1)[0] ?? '');
}

export function cleanImportPath(importPath: string): string {
  return importPath.trim().replace(/[)\]}.,;:!?"'>]+$/g, '');
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

async function readCachedTextFile(
  filePath: string,
  now: number
): Promise<CachedTextFile | undefined> {
  const resolvedPath = path.resolve(filePath);
  const fingerprint = await fingerprintPath(filePath, now);
  const cached = textFileCache.get(resolvedPath);

  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return cached;
  }

  if (cached !== undefined) {
    textFileCache.delete(resolvedPath);
  }

  const content = await readTextFile(filePath);

  if (content === undefined) {
    return undefined;
  }

  const snapshot = {
    fingerprint,
    content,
    tokenCount: countTokens(content)
  };

  textFileCache.set(resolvedPath, snapshot);
  return snapshot;
}

async function readDeferredToolsFromSession(
  sessionPath: string,
  now: number
): Promise<ReadonlySet<string> | undefined> {
  const resolvedPath = path.resolve(sessionPath);
  const cached = toolSetCache.get(resolvedPath);
  let stats: import('fs').Stats;

  try {
    stats = await fsp.stat(sessionPath);
    missingFingerprintCache.delete(resolvedPath);
  } catch {
    missingFingerprintCache.set(resolvedPath, {
      fingerprint: `${resolvedPath}:missing`,
      expiresAt: now + CLAUDE_MD_MISSING_FINGERPRINT_TTL_MS
    });
    toolSetCache.delete(resolvedPath);
    return undefined;
  }

  if (cached !== undefined && stats.size === cached.offset && stats.mtimeMs === cached.mtimeMs) {
    return cached.tools;
  }

  const canReadAppendedBytes =
    cached !== undefined &&
    stats.size > cached.offset &&
    await fileSuffixMatches(sessionPath, cached.offset, cached.suffix);
  // Re-read from the beginning after truncation, same-size rewrite, or append
  // where the cached suffix no longer matches the file prefix.
  const truncated =
    cached !== undefined &&
    (stats.size < cached.offset ||
      (stats.size === cached.offset && stats.mtimeMs !== cached.mtimeMs) ||
      (stats.size > cached.offset && !canReadAppendedBytes));
  const offset = cached === undefined || truncated ? 0 : cached.offset;
  const activeTools = new Set(cached === undefined || truncated ? [] : cached.tools);
  const previousRemainder = cached === undefined || truncated ? '' : cached.remainder;
  const previousSuffix = cached === undefined || truncated ? Buffer.alloc(0) : cached.suffix;

  try {
    const { remainder, bytesRead, suffix } = await readDeferredToolDeltaBytes(
      sessionPath,
      offset,
      stats.size - offset,
      previousRemainder,
      previousSuffix,
      activeTools
    );

    toolSetCache.set(resolvedPath, {
      mtimeMs: stats.mtimeMs,
      offset: offset + bytesRead,
      remainder,
      suffix,
      tools: activeTools
    });
  } catch {
    toolSetCache.delete(resolvedPath);
    return undefined;
  }

  return activeTools;
}

async function fileSuffixMatches(
  filePath: string,
  offset: number,
  expectedSuffix: Buffer
): Promise<boolean> {
  if (expectedSuffix.length === 0) {
    return true;
  }

  const suffixStart = offset - expectedSuffix.length;

  if (suffixStart < 0) {
    return false;
  }

  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;

  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(expectedSuffix.length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      expectedSuffix.length,
      suffixStart
    );

    return bytesRead === expectedSuffix.length && buffer.equals(expectedSuffix);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function readDeferredToolDeltaBytes(
  filePath: string,
  offset: number,
  length: number,
  previousRemainder: string,
  previousSuffix: Buffer,
  activeTools: Set<string>
): Promise<{ readonly remainder: string; readonly bytesRead: number; readonly suffix: Buffer }> {
  if (length <= 0) {
    return {
      remainder: previousRemainder,
      bytesRead: 0,
      suffix: previousSuffix
    };
  }

  const handle = await fsp.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const chunk = buffer.subarray(0, bytesRead);
    const remainder = consumeDeferredToolChunk(
      previousRemainder,
      chunk.toString('utf8'),
      activeTools
    );
    const suffix = getUpdatedToolCacheSuffix(previousSuffix, chunk);

    return { remainder, bytesRead, suffix };
  } finally {
    await handle.close();
  }
}

function getUpdatedToolCacheSuffix(previousSuffix: Buffer, chunk: Buffer): Buffer {
  const combined =
    previousSuffix.length === 0 ? chunk : Buffer.concat([previousSuffix, chunk]);

  return combined.subarray(Math.max(0, combined.length - TOOL_CACHE_SUFFIX_BYTES));
}

function consumeDeferredToolChunk(
  previousRemainder: string,
  chunk: string,
  activeTools: Set<string>
): string {
  const combined = `${previousRemainder}${chunk}`;
  const complete = combined.endsWith('\n');
  const lines = combined.split(/\r?\n/);
  const completeLines = complete ? lines : lines.slice(0, -1);
  const remainder = complete ? '' : lines.at(-1) ?? '';

  for (const lineText of completeLines) {
    consumeDeferredToolLine(activeTools, lineText);
  }

  if (!complete && remainder.trim() !== '' && consumeDeferredToolLine(activeTools, remainder) === 'toolDelta') {
    return '';
  }

  return remainder;
}

type DeferredToolLineResult = 'complete' | 'incomplete' | 'toolDelta';

function consumeDeferredToolLine(
  activeTools: Set<string>,
  lineText: string
): DeferredToolLineResult {
  if (lineText.trim() === '') {
    return 'complete';
  }

  let line: unknown;

  try {
    line = JSON.parse(lineText) as unknown;
  } catch {
    return 'incomplete';
  }

  if (isRecord(line) && line.isSidechain === true) {
    return 'complete';
  }

  if (!isDeferredToolsDelta(line)) {
    return 'complete';
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

  return 'toolDelta';
}

function maybePruneExpiredContextBreakdownCache(now: number): void {
  if (now - lastContextBreakdownPruneAt < CONTEXT_BREAKDOWN_PRUNE_INTERVAL_MS) {
    return;
  }

  lastContextBreakdownPruneAt = now;
  pruneExpiredContextBreakdownCache(now);
  pruneExpiredMissingFingerprintCache(now);
}

function pruneExpiredContextBreakdownCache(now: number): void {
  for (const entry of cache.values()) {
    if (entry.expiresAt <= now) {
      cache.delete(entry.key);
    }
  }
}

function pruneExpiredMissingFingerprintCache(now: number): void {
  for (const [filePath, entry] of missingFingerprintCache.entries()) {
    if (entry.expiresAt <= now) {
      missingFingerprintCache.delete(filePath);
    }
  }
}

function isAllowedClaudeMdImport(
  resolvedPath: string,
  sourceDir: string,
  workspaceRoot: string | undefined,
  homeDir: string
): boolean {
  const claudeConfigRoot = path.join(homeDir, '.claude');

  return (
    isPathWithinRoot(resolvedPath, claudeConfigRoot) ||
    isPathWithinRoot(resolvedPath, sourceDir) ||
    (workspaceRoot !== undefined && isPathWithinRoot(resolvedPath, workspaceRoot))
  );
}

function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const resolvedRoot = normalizePathForRootComparison(path.resolve(root));
  const resolvedCandidate = normalizePathForRootComparison(path.resolve(candidatePath));
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathForRootComparison(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function getStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
