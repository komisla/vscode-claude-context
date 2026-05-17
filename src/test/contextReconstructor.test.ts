import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContextUpdate } from '../dataSource';
import {
  CC_BASE_SYSTEM_PROMPT_TOKENS,
  TOKENS_PER_BUILTIN_TOOL,
  TOKENS_PER_MCP_TOOL,
  clearContextBreakdownCache,
  countClaudeMdTokens,
  countMemoryTokens,
  countTokens,
  estimateToolTokens,
  isDeferredToolsDelta,
  isMcpToolName,
  reconstructContextBreakdown,
  replayDeferredTools
} from '../contextReconstructor';

test('counts workspace, parent, global CLAUDE.md files and direct imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-reconstruct-'));

  try {
    const homeDir = path.join(root, 'home');
    const globalClaudeDir = path.join(homeDir, '.claude');
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(globalClaudeDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });

    const globalClaude = 'global rules @./global-import.md';
    const globalImport = 'global imported';
    const parentClaude = 'parent rules @./parent-import.md\nRepo @long-kudo/vscode-claude-status';
    const parentImport = 'parent imported';
    const workspaceClaude = `workspace rules @./workspace-import.md for details @missing.md @./my-package.md\nLies @issue.md genau\nEmail slavik@korbinian.eu\nPackage @types/node`;
    const workspaceImport = 'workspace imported';
    const relativeImport = 'relative import should be counted';
    const falsePositiveImport = 'false positive should not be counted';
    const emailMatch = 'email-like import should not be counted';
    const repoReference = 'repo reference should not be imported';
    const npmPackage = 'package should not be imported';

    await writeFile(path.join(globalClaudeDir, 'CLAUDE.md'), globalClaude);
    await writeFile(path.join(globalClaudeDir, 'global-import.md'), globalImport);
    await writeFile(path.join(root, 'repo', 'CLAUDE.md'), parentClaude);
    await writeFile(path.join(root, 'repo', 'parent-import.md'), parentImport);
    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(workspaceRoot, 'workspace-import.md'), workspaceImport);
    await writeFile(path.join(workspaceRoot, 'my-package.md'), relativeImport);
    await writeFile(path.join(workspaceRoot, 'issue.md'), falsePositiveImport);
    await writeFile(path.join(workspaceRoot, 'korbinian.eu'), emailMatch);
    await mkdir(path.join(root, 'repo', 'long-kudo'), { recursive: true });
    await writeFile(path.join(root, 'repo', 'long-kudo', 'vscode-claude-status'), repoReference);
    await mkdir(path.join(workspaceRoot, 'types'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'types', 'node'), npmPackage);

    const expected = [
      globalClaude,
      globalImport,
      parentClaude,
      workspaceClaude,
      workspaceImport,
      relativeImport
    ].reduce((sum, content) => sum + countTokens(content), 0);

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores @ imports inside fenced and inline code', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-code-block-'));

  try {
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(workspaceRoot, { recursive: true });

    const workspaceClaude = [
      'workspace rules',
      '```md',
      '@./code-block.md',
      '```',
      'Inline `@./inline.md` reference',
      '@./included.md'
    ].join('\n');

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(workspaceRoot, 'code-block.md'), 'code block import should be ignored');
    await writeFile(path.join(workspaceRoot, 'inline.md'), 'inline import should be ignored');
    await writeFile(path.join(workspaceRoot, 'included.md'), 'included import should be counted');

    const expected = countTokens(workspaceClaude) + countTokens('included import should be counted');

    assert.equal(await countClaudeMdTokens(workspaceRoot, path.join(root, 'home')), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bare @name.md references are ignored during CLAUDE.md import counting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-bare-import-'));

  try {
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(workspaceRoot, { recursive: true });

    const workspaceClaude = 'workspace rules @issue.md';
    const bareImport = 'bare import should not be counted';

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(workspaceRoot, 'issue.md'), bareImport);

    assert.equal(
      await countClaudeMdTokens(workspaceRoot, path.join(root, 'home')),
      countTokens(workspaceClaude)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recursively counts nested CLAUDE.md imports and stops on cycles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-nested-'));

  try {
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(workspaceRoot, { recursive: true });

    const rootClaude = 'root rules @./child.md';
    const childClaude = 'child rules @./nested.md';
    const nestedClaude = 'nested rules @./CLAUDE.md';

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), rootClaude);
    await writeFile(path.join(workspaceRoot, 'child.md'), childClaude);
    await writeFile(path.join(workspaceRoot, 'nested.md'), nestedClaude);

    const expected = [rootClaude, childClaude, nestedClaude].reduce(
      (sum, content) => sum + countTokens(content),
      0
    );

    assert.equal(await countClaudeMdTokens(workspaceRoot, path.join(root, 'home')), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects @ imports outside workspace root and home dir', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-import-guard-'));

  try {
    const homeDir = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(workspaceRoot, { recursive: true });

    const workspaceClaude = [
      'workspace rules',
      '@./allowed.md',
      '@../outside.md',
      `@${path.resolve(root, 'absolute-outside.md')}`,
      '@~/../home-escape.md'
    ].join(' ');

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(workspaceRoot, 'allowed.md'), 'allowed import');
    await writeFile(path.join(root, 'repo', 'outside.md'), 'outside import');
    await writeFile(path.resolve(root, 'absolute-outside.md'), 'absolute outside import');
    await writeFile(path.join(root, 'home-escape.md'), 'home escape import');

    const expected = countTokens(workspaceClaude) + countTokens('allowed import');

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('limits CLAUDE.md import recursion depth to 10 levels', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-import-depth-'));

  try {
    const homeDir = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(workspaceRoot, { recursive: true });

    const fileContents = new Map<string, string>();

    for (let index = 1; index <= 11; index += 1) {
      const nextImport = index < 11 ? ` @./level${index + 1}.md` : '';
      fileContents.set(`level${index}.md`, `level ${index}${nextImport}`);
    }

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), 'root @./level1.md');

    for (const [fileName, content] of fileContents) {
      await writeFile(path.join(workspaceRoot, fileName), content);
    }

    const expected = [
      'root @./level1.md',
      ...Array.from({ length: 10 }, (_, index) => fileContents.get(`level${index + 1}.md`) ?? '')
    ].reduce((sum, content) => sum + countTokens(content), 0);

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('counts memory markdown files beside the current session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-memory-'));

  try {
    const memoryDir = path.join(root, 'memory');
    await mkdir(memoryDir);
    await writeFile(path.join(root, 'session.jsonl'), '');
    await writeFile(path.join(memoryDir, 'one.md'), 'first memory');
    await writeFile(path.join(memoryDir, 'two.md'), 'second memory');
    await writeFile(path.join(memoryDir, 'ignored.txt'), 'not counted');

    assert.equal(
      await countMemoryTokens(path.join(root, 'session.jsonl')),
      countTokens('first memory') + countTokens('second memory')
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replays deferred tool deltas and counts MCP tools separately', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-tools-'));

  try {
    const sessionPath = path.join(root, 'session.jsonl');
    const firstDelta = {
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['Bash', 'mcp__claude_ai_Gmail__authenticate']
      }
    };
    const secondDelta = {
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        removedNames: ['Bash'],
        readdedNames: ['Read']
      }
    };
    const sidechainDelta = {
      type: 'attachment',
      isSidechain: true,
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['Write']
      }
    };

    await writeFile(sessionPath, [
      JSON.stringify(firstDelta),
      JSON.stringify({ type: 'message' }),
      JSON.stringify(sidechainDelta),
      JSON.stringify(secondDelta)
    ].join('\n'));

    assert.equal(isDeferredToolsDelta(firstDelta), true);
    assert.equal(isMcpToolName('mcp__claude_ai_Gmail__authenticate'), true);
    assert.deepEqual(Array.from(replayDeferredTools(await readFileText(sessionPath))).sort(), [
      'Read',
      'mcp__claude_ai_Gmail__authenticate'
    ]);
    assert.equal(await estimateToolTokens(sessionPath), TOKENS_PER_BUILTIN_TOOL + TOKENS_PER_MCP_TOOL);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor clamps conversation and always marks estimates', async () => {
  clearContextBreakdownCache();

  const breakdown = await reconstructContextBreakdown(
    {
      totalTokens: 1,
      effectiveWindow: 178_808,
      fillPercent: 1,
      sessionPath: path.join('missing', 'session.jsonl')
    },
    {
      workspaceRoot: path.join('missing', 'workspace'),
      homeDir: path.join('missing', 'home'),
      now: () => Date.parse('2026-05-16T12:00:00Z')
    }
  );

  assert.equal(breakdown.categories.systemPrompt, CC_BASE_SYSTEM_PROMPT_TOKENS);
  assert.equal(breakdown.categories.conversation, 0);
  assert.equal(breakdown.systemPromptDriftWarning, true);
  assert.equal(breakdown.isEstimate, true);
  assert.equal(breakdown.fillPercent, 1);
});

test('reconstructor invalidates when sessionPath mtime changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-cache-'));
  clearContextBreakdownCache();

  try {
    const sessionPath = path.join(root, 'session.jsonl');
    const source = {
      totalTokens: 20_000,
      effectiveWindow: 178_808,
      fillPercent: 11,
      sessionPath
    };

    await writeFile(sessionPath, makeToolDelta(['Bash']));
    const first = await reconstructContextBreakdown(source, {
      workspaceRoot: root,
      homeDir: path.join(root, 'home'),
      now: () => 1_000
    });

    await writeFile(sessionPath, makeToolDelta(['Bash', 'Read']));
    const cached = await reconstructContextBreakdown(source, {
      workspaceRoot: root,
      homeDir: path.join(root, 'home'),
      now: () => 2_000
    });
    const invalidated = await reconstructContextBreakdown(
      { ...source, totalTokens: 20_001 },
      {
        workspaceRoot: root,
        homeDir: path.join(root, 'home'),
        now: () => 3_000
      }
    );

    assert.equal(first.categories.tools, TOKENS_PER_BUILTIN_TOOL);
    assert.equal(cached.categories.tools, TOKENS_PER_BUILTIN_TOOL * 2);
    assert.equal(invalidated.categories.tools, TOKENS_PER_BUILTIN_TOOL * 2);
  } finally {
    clearContextBreakdownCache();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor reuses the cache for equivalent sources with different property order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-cache-key-'));
  clearContextBreakdownCache();

  const homeDir = path.join(root, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'shared content');

  const mutableFsPromises = fsPromises as {
    readFile: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReadFile = mutableFsPromises.readFile;
  let claudeMdReadCount = 0;

  mutableFsPromises.readFile = async (...args: unknown[]) => {
    const [filePath] = args;

    if (typeof filePath === 'string' && filePath.endsWith(path.join('.claude', 'CLAUDE.md'))) {
      claudeMdReadCount += 1;
    }

    return originalReadFile(...args);
  };

  try {
    const firstSource = {
      totalTokens: 5_000,
      effectiveWindow: 178_808,
      fillPercent: 3
    } satisfies ContextUpdate;
    const secondSource = {
      fillPercent: 3,
      effectiveWindow: 178_808,
      totalTokens: 5_000
    } satisfies ContextUpdate;

    const [first, second] = await Promise.all([
      reconstructContextBreakdown(firstSource, {
        homeDir,
        now: () => 1_000
      }),
      reconstructContextBreakdown(secondSource, {
        homeDir,
        now: () => 1_000
      })
    ]);

    assert.strictEqual(first, second);
    assert.equal(claudeMdReadCount, 1);
  } finally {
    mutableFsPromises.readFile = originalReadFile;
    clearContextBreakdownCache();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor reuses cached CLAUDE.md snapshots when only the source changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-snapshot-cache-'));
  clearContextBreakdownCache();

  const homeDir = path.join(root, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'shared content');

  const mutableFsPromises = fsPromises as {
    readFile: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReadFile = mutableFsPromises.readFile;
  let claudeMdReadCount = 0;

  mutableFsPromises.readFile = async (...args: unknown[]) => {
    const [filePath] = args;

    if (typeof filePath === 'string' && filePath.endsWith(path.join('.claude', 'CLAUDE.md'))) {
      claudeMdReadCount += 1;
    }

    return originalReadFile(...args);
  };

  try {
    const firstSource = {
      totalTokens: 5_000,
      effectiveWindow: 178_808,
      fillPercent: 3
    } satisfies ContextUpdate;
    const secondSource = {
      totalTokens: 6_000,
      effectiveWindow: 178_808,
      fillPercent: 3
    } satisfies ContextUpdate;

    const first = await reconstructContextBreakdown(firstSource, {
      homeDir,
      now: () => 1_000
    });
    const second = await reconstructContextBreakdown(secondSource, {
      homeDir,
      now: () => 2_000
    });

    assert.equal(first.categories.claudeMd, countTokens('shared content'));
    assert.equal(second.categories.claudeMd, countTokens('shared content'));
    assert.equal(claudeMdReadCount, 1);
  } finally {
    mutableFsPromises.readFile = originalReadFile;
    clearContextBreakdownCache();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor invalidates when CLAUDE.md mtime changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-mtime-'));
  clearContextBreakdownCache();

  const homeDir = path.join(root, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, 'CLAUDE.md');
  await writeFile(claudePath, 'alpha');

  const mutableFsPromises = fsPromises as {
    readFile: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReadFile = mutableFsPromises.readFile;
  let claudeMdReadCount = 0;

  mutableFsPromises.readFile = async (...args: unknown[]) => {
    const [filePath] = args;

    if (typeof filePath === 'string' && filePath.endsWith(path.join('.claude', 'CLAUDE.md'))) {
      claudeMdReadCount += 1;
    }

    return originalReadFile(...args);
  };

  try {
    const source = {
      totalTokens: 5_000,
      effectiveWindow: 178_808,
      fillPercent: 3
    } satisfies ContextUpdate;

    const first = await reconstructContextBreakdown(source, {
      homeDir,
      now: () => 1_000
    });

    await writeFile(claudePath, 'alpha beta');
    const changed = new Date('2026-05-16T11:30:00Z');
    await utimes(claudePath, changed, changed);

    const second = await reconstructContextBreakdown(source, {
      homeDir,
      now: () => 2_000
    });

    assert.equal(first.categories.claudeMd, countTokens('alpha'));
    assert.equal(second.categories.claudeMd, countTokens('alpha beta'));
    assert.equal(claudeMdReadCount, 2);
  } finally {
    mutableFsPromises.readFile = originalReadFile;
    clearContextBreakdownCache();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor shares in-flight work for concurrent calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-inflight-'));
  clearContextBreakdownCache();

  const homeDir = path.join(root, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'shared content');

  const mutableFsPromises = fsPromises as {
    readFile: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReadFile = mutableFsPromises.readFile;
  let readCount = 0;

  mutableFsPromises.readFile = async (...args: unknown[]) => {
    const [filePath] = args;

    if (typeof filePath === 'string' && filePath.endsWith(path.join('.claude', 'CLAUDE.md'))) {
      readCount += 1;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    }

    return originalReadFile(...args);
  };

  try {
    const source = {
      totalTokens: 5_000,
      effectiveWindow: 178_808,
      fillPercent: 3
    };

    const [first, second] = await Promise.all([
      reconstructContextBreakdown(source, {
        homeDir,
        now: () => 1_000
      }),
      reconstructContextBreakdown(source, {
        homeDir,
        now: () => 1_000
      })
    ]);

    assert.strictEqual(first, second);
    assert.equal(readCount, 1);
    assert.equal(first.categories.claudeMd, countTokens('shared content'));
  } finally {
    mutableFsPromises.readFile = originalReadFile;
    clearContextBreakdownCache();
    await rm(root, { recursive: true, force: true });
  }
});

async function readFileText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

function makeToolDelta(addedNames: readonly string[]): string {
  return JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'deferred_tools_delta',
      addedNames
    }
  });
}
