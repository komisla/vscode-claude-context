import { createReadStream, promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { createInterface } from 'readline';
import { encode } from 'gpt-tokenizer';
import type { ContextUpdate } from './dataSource';

export const CC_BASE_SYSTEM_PROMPT_TOKENS = 8_000; // measured on CC v2.1.143, 2026-05-16
export const TOKENS_PER_BUILTIN_TOOL = 300;
export const TOKENS_PER_MCP_TOOL = 400;
export const BREAKDOWN_CACHE_MS = 30_000;
const MIN_TOKENS_FOR_DRIFT_WARNING = 20_000;
const CONTEXT_BREAKDOWN_PRUNE_INTERVAL_MS = 60_000;
const CLAUDE_MD_MISSING_FINGERPRINT_TTL_MS = 5_000;
const MAX_IMPORTED_CLAUDE_MD_DEPTH = 10;

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

interface MissingFingerprintEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ContextBreakdown>>();
const textFileCache = new Map<string, CachedTextFile>();
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
  const key = await getCacheKey(source, options.workspaceRoot, homeDir);
  const totalTokens = source.totalTokens;
  const cached = cache.get(key);

  if (cached !== undefined && cached.expiresAt > now) {
    maybePruneExpiredContextBreakdownCache(now);
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
    maybePruneExpiredContextBreakdownCache(now);

    return emptyBreakdown;
  }

  const pending = inFlight.get(key);

  if (pending !== undefined) {
    return pending;
  }

  const promise = (async () => {
    const systemPrompt = CC_BASE_SYSTEM_PROMPT_TOKENS;
    const claudeMd = await countClaudeMdTokens(options.workspaceRoot, homeDir);
    const memory = await countMemoryTokens(source.sessionPath);
    const tools = await estimateToolTokens(source.sessionPath);
    const conversation = Math.max(0, totalTokens - systemPrompt - claudeMd - memory - tools);
    const systemPromptDriftWarning = conversation === 0 && totalTokens >= MIN_TOKENS_FOR_DRIFT_WARNING;
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

export async function countClaudeMdTokens(
  workspaceRoot: string | undefined,
  homeDir = os.homedir()
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
      snapshot: await readCachedTextFile(filePath)
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

  const memoryFiles = await Promise.all(
    entries.flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        return [];
      }

      const filePath = path.join(memoryDir, entry.name);
      return [
        (async () => ({
          filePath,
          snapshot: await readCachedTextFile(filePath)
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

export async function estimateToolTokens(sessionPath: string | undefined): Promise<number> {
  if (sessionPath === undefined) {
    return 0;
  }

  const activeTools = await readDeferredToolsFromSession(sessionPath);

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
    applyDeferredToolsDeltaLine(activeTools, lineText);
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
  homeDir: string
): Promise<string> {
  const parts = [
    source.sessionPath,
    source.totalTokens,
    source.effectiveWindow,
    source.contextWindow,
    source.fillPercent,
    workspaceRoot,
    homeDir,
    ...(await getSessionPathFingerprint(source.sessionPath)),
    ...(await getClaudeMdFingerprint(workspaceRoot, homeDir)),
    ...(await getMemoryFingerprint(source.sessionPath))
  ];

  return parts.join('|');
}

async function getSessionPathFingerprint(sessionPath: string | undefined): Promise<readonly string[]> {
  if (sessionPath === undefined) {
    return [];
  }

  return [await fingerprintPath(sessionPath)];
}

async function getClaudeMdFingerprint(
  workspaceRoot: string | undefined,
  homeDir: string
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
    fingerprints.push(await fingerprintPath(filePath));
  }

  return fingerprints;
}

async function getMemoryFingerprint(sessionPath: string | undefined): Promise<readonly string[]> {
  if (sessionPath === undefined) {
    return [];
  }

  const memoryDir = path.join(path.dirname(sessionPath), 'memory');
  let entries: import('fs').Dirent[];

  try {
    entries = await fsp.readdir(memoryDir, { withFileTypes: true });
  } catch {
    return [await fingerprintPath(memoryDir)];
  }

  const fingerprints: string[] = [];

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    fingerprints.push(await fingerprintPath(path.join(memoryDir, entry.name)));
  }

  return fingerprints;
}

async function fingerprintPath(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const now = Date.now();
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

    const importedSnapshot = await readCachedTextFile(normalizedPath);

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
      visited,
      depth + 1
    );
  }

  return total;
}

function extractAtImports(content: string): readonly string[] {
  const imports: string[] = [];
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^\n`]+`/g, ' ');
  const regex = /(?:^|\s)@([^\s@]+)/g;
  let match = regex.exec(stripped);

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

    match = regex.exec(stripped);
  }

  return imports;
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

async function readCachedTextFile(filePath: string): Promise<CachedTextFile | undefined> {
  const resolvedPath = path.resolve(filePath);
  const fingerprint = await fingerprintPath(filePath);
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
  sessionPath: string
): Promise<ReadonlySet<string> | undefined> {
  const activeTools = new Set<string>();

  try {
    const stream = createReadStream(sessionPath, { encoding: 'utf8' });
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    try {
      for await (const lineText of rl) {
        applyDeferredToolsDeltaLine(activeTools, lineText);
      }
    } finally {
      rl.close();
    }
  } catch {
    return undefined;
  }

  return activeTools;
}

function applyDeferredToolsDeltaLine(activeTools: Set<string>, lineText: string): void {
  if (lineText.trim() === '') {
    return;
  }

  let line: unknown;

  try {
    line = JSON.parse(lineText) as unknown;
  } catch {
    return;
  }

  if (isRecord(line) && line.isSidechain === true) {
    return;
  }

  if (!isDeferredToolsDelta(line)) {
    return;
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

function maybePruneExpiredContextBreakdownCache(now: number): void {
  if (now - lastContextBreakdownPruneAt < CONTEXT_BREAKDOWN_PRUNE_INTERVAL_MS) {
    return;
  }

  lastContextBreakdownPruneAt = now;
  pruneExpiredContextBreakdownCache(now);
}

function pruneExpiredContextBreakdownCache(now: number): void {
  for (const entry of cache.values()) {
    if (entry.expiresAt <= now) {
      cache.delete(entry.key);
    }
  }
}

function isAllowedClaudeMdImport(
  resolvedPath: string,
  sourceDir: string,
  workspaceRoot: string | undefined,
  homeDir: string
): boolean {
  return (
    isPathWithinRoot(resolvedPath, homeDir) ||
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
