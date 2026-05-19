import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContextUpdate } from '../dataSource';
import {
  CC_BASE_SYSTEM_PROMPT_TOKENS,
  TOKENS_PER_BUILTIN_TOOL,
  TOKENS_PER_MCP_TOOL,
  cleanImportPath,
  clearAllContextCaches,
  countClaudeMdTokens,
  countMemoryTokens,
  countTokens,
  estimateToolTokens,
  isDeferredToolsDelta,
  isMcpToolName,
  extractAtImports,
  reconstructContextBreakdown,
  replayDeferredTools
} from '../contextReconstructor';

test('counts workspace, ancestor, global CLAUDE.md files and direct imports', async () => {
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
      parentImport,
      workspaceClaude,
      workspaceImport,
      relativeImport
    ].reduce((sum, content) => sum + countTokens(content), 0);

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('counts CLAUDE.md relative imports with spaces in the path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-space-import-'));

  try {
    const workspaceRoot = path.join(root, 'repo', 'app');
    const importsDir = path.join(workspaceRoot, 'path with spaces');
    await mkdir(importsDir, { recursive: true });

    const workspaceClaude = 'workspace rules @./path with spaces/file.md';
    const importContent = 'relative import with spaces should be counted';

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(importsDir, 'file.md'), importContent);

    const expected = countTokens(workspaceClaude) + countTokens(importContent);

    assert.equal(await countClaudeMdTokens(workspaceRoot, path.join(root, 'home')), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('counts CLAUDE.md ~/.claude imports with spaces in the path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-home-space-import-'));

  try {
    const homeDir = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'repo', 'app');
    const homeProjectDir = path.join(homeDir, '.claude', 'My Project');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeProjectDir, { recursive: true });

    const workspaceClaude = 'workspace rules @~/.claude/My Project/CLAUDE.md';
    const importContent = 'home import with spaces should be counted';

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(homeProjectDir, 'CLAUDE.md'), importContent);

    const expected = countTokens(workspaceClaude) + countTokens(importContent);

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects CLAUDE.md ~/ imports outside .claude', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-home-import-guard-'));

  try {
    const homeDir = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'repo', 'app');
    const documentsDir = path.join(homeDir, 'Documents');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(documentsDir, { recursive: true });

    const workspaceClaude = 'workspace rules @~/Documents/anything.txt';
    const rejectedImport = 'document import should not be counted';

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(documentsDir, 'anything.txt'), rejectedImport);

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), countTokens(workspaceClaude));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('counts quoted CLAUDE.md imports with spaces in the path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-quoted-space-import-'));

  try {
    const workspaceRoot = path.join(root, 'repo', 'app');
    const importsDir = path.join(workspaceRoot, 'quoted imports');
    await mkdir(importsDir, { recursive: true });

    const workspaceClaude = 'workspace rules @"./quoted imports/file.md"';
    const importContent = 'quoted import with spaces should be counted';

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(importsDir, 'file.md'), importContent);

    const expected = countTokens(workspaceClaude) + countTokens(importContent);

    assert.equal(await countClaudeMdTokens(workspaceRoot, path.join(root, 'home')), expected);
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

test('ignores Unix absolute-path @ imports during CLAUDE.md import extraction', async () => {
  const imports = extractAtImports('keep @./relative.md but ignore @/api/auth and @/issues/42');

  assert.deepEqual(imports, ['./relative.md']);
});

test('ignores imports inside comments and code blocks during CLAUDE.md import counting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-comment-import-'));

  try {
    const homeDir = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'repo', 'app');
    await mkdir(workspaceRoot, { recursive: true });

    const workspaceClaude = [
      'workspace rules',
      '<!-- @./commented.md -->',
      '```md',
      '@./fenced.md',
      '```',
      'Use `@./inline.md` for examples',
      '@./active.md'
    ].join('\n');

    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(workspaceRoot, 'commented.md'), 'commented import should not count');
    await writeFile(path.join(workspaceRoot, 'fenced.md'), 'fenced import should not count');
    await writeFile(path.join(workspaceRoot, 'inline.md'), 'inline import should not count');
    await writeFile(path.join(workspaceRoot, 'active.md'), 'active import should count');

    const expected = countTokens(workspaceClaude) + countTokens('active import should count');

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
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

test(
  'counts CLAUDE.md imports when Windows drive-letter case differs',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claude-context-drive-case-'));

    try {
      const homeDir = path.join(root, 'home');
      const workspaceRoot = path.join(root, 'repo', 'app');
      await mkdir(workspaceRoot, { recursive: true });

      const workspaceClaude = 'workspace rules @./allowed.md';
      const importContent = 'allowed import despite drive-letter case mismatch';
      await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
      await writeFile(path.join(workspaceRoot, 'allowed.md'), importContent);

      const mismatchedWorkspaceRoot = flipWindowsDriveLetterCase(workspaceRoot);
      const expected = countTokens(workspaceClaude) + countTokens(importContent);

      assert.equal(await countClaudeMdTokens(mismatchedWorkspaceRoot, homeDir), expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

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

test('estimateToolTokens caches deferred tool sets by session fingerprint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-tools-cache-'));
  clearAllContextCaches();

  try {
    const sessionPath = path.join(root, 'session.jsonl');
    const firstDeltaLine = makeToolDelta(['LongToolName']);
    const secondDeltaLine = makeToolDelta(['mcp__x__tool']);
    const paddedLength = Math.max(
      Buffer.byteLength(firstDeltaLine),
      Buffer.byteLength(secondDeltaLine)
    );
    const firstDelta = padJsonlLineToByteLength(firstDeltaLine, paddedLength);
    const secondDelta = padJsonlLineToByteLength(secondDeltaLine, paddedLength);
    const mutableFsPromises = fsPromises as {
      stat: (...args: unknown[]) => Promise<unknown>;
    };
    const originalStat = mutableFsPromises.stat;

    await writeFile(sessionPath, firstDelta);
    const originalStats = await originalStat(sessionPath);

    mutableFsPromises.stat = async (...args: unknown[]) => {
      const [filePath] = args;

      if (filePath === sessionPath) {
        return originalStats;
      }

      return originalStat(...args);
    };

    try {
      assert.equal(await estimateToolTokens(sessionPath, 1_000), TOKENS_PER_BUILTIN_TOOL);

      await writeFile(sessionPath, secondDelta);

      assert.equal(await estimateToolTokens(sessionPath, 2_000), TOKENS_PER_BUILTIN_TOOL);

      clearAllContextCaches();

      assert.equal(await estimateToolTokens(sessionPath, 3_000), TOKENS_PER_MCP_TOOL);
    } finally {
      mutableFsPromises.stat = originalStat;
    }
  } finally {
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('estimateToolTokens keeps valid non-tool partial lines as remainders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-tools-remainder-'));
  clearAllContextCaches();

  const mutableMapPrototype = Map.prototype as unknown as {
    set: (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown
    ) => Map<unknown, unknown>;
  };
  const originalSet = mutableMapPrototype.set;
  let toolSetRemainder: string | undefined;

  mutableMapPrototype.set = function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ): Map<unknown, unknown> {
    if (isCachedToolSetValue(value)) {
      toolSetRemainder = value.remainder;
    }

    return originalSet.call(this, key, value);
  };

  try {
    const sessionPath = path.join(root, 'session.jsonl');
    const partialMessage = JSON.stringify({ type: 'message' });

    await writeFile(sessionPath, `${makeToolDelta(['Bash'])}\n${partialMessage}`);

    assert.equal(await estimateToolTokens(sessionPath, 1_000), TOKENS_PER_BUILTIN_TOOL);
    assert.equal(toolSetRemainder, partialMessage);
  } finally {
    mutableMapPrototype.set = originalSet;
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor warns when fixed categories exceed total tokens', async () => {
  clearAllContextCaches();

  const breakdown = await reconstructContextBreakdown(
    {
      totalTokens: 1,
      effectiveWindow: 178_808,
      contextWindow: 200_000,
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
  assert.equal(breakdown.contextWindow, 200_000);
});

test('reconstructor keeps raw context window in cache identity', async () => {
  clearAllContextCaches();

  const source = {
    totalTokens: 1_000,
    contextWindow: 100_000,
    fillPercent: 1,
    sessionPath: path.join('missing', 'session.jsonl')
  };
  const options = {
    workspaceRoot: path.join('missing', 'workspace'),
    homeDir: path.join('missing', 'home'),
    now: () => Date.parse('2026-05-16T12:00:00Z')
  };

  const first = await reconstructContextBreakdown(source, options);
  const second = await reconstructContextBreakdown({ ...source, contextWindow: 200_000 }, options);

  assert.equal(first.contextWindow, 100_000);
  assert.equal(first.effectiveWindow, 100_000);
  assert.equal(second.contextWindow, 200_000);
  assert.equal(second.effectiveWindow, 200_000);
});

test('reconstructor warns on large zero-conversation sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-drift-'));
  clearAllContextCaches();

  try {
    const homeDir = path.join(root, 'home');
    const claudeDir = path.join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });

    const hugeClaude = Array.from({ length: 14_000 }, (_, index) => `token${index}`).join(' ');
    await writeFile(path.join(claudeDir, 'CLAUDE.md'), hugeClaude);

    const breakdown = await reconstructContextBreakdown(
      {
        totalTokens: 20_000,
        effectiveWindow: 178_808,
        fillPercent: 11,
        sessionPath: path.join(root, 'missing', 'session.jsonl')
      },
      {
        homeDir,
        workspaceRoot: path.join(root, 'missing', 'workspace'),
        now: () => Date.parse('2026-05-16T12:00:00Z')
      }
    );

    assert.equal(breakdown.categories.conversation, 0);
    assert.equal(breakdown.systemPromptDriftWarning, true);
  } finally {
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor invalidates when sessionPath mtime changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-cache-'));
  clearAllContextCaches();

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
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor reuses fixed categories within a total-token bucket', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-token-bucket-'));
  clearAllContextCaches();

  try {
    const sessionPath = path.join(root, 'session.jsonl');
    const initialLine = `${makeToolDelta(['Bash'])}\n`;
    const appendedLine = `${JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 20_100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0
        }
      }
    })}\n`;
    const mutableFsPromises = fsPromises as {
      open: (...args: unknown[]) => Promise<unknown>;
    };
    const originalOpen = mutableFsPromises.open;
    const sessionReadLengths: number[] = [];

    mutableFsPromises.open = async (...args: unknown[]) => {
      const handle = await originalOpen(...args);
      const [filePath] = args;

      if (filePath === sessionPath) {
        const mutableHandle = handle as {
          read: (...readArgs: unknown[]) => Promise<unknown>;
        };
        const originalRead = mutableHandle.read;

        mutableHandle.read = async (...readArgs: unknown[]) => {
          const length = readArgs[2];

          if (typeof length === 'number') {
            sessionReadLengths.push(length);
          }

          return Reflect.apply(originalRead, handle, readArgs) as Promise<unknown>;
        };
      }

      return handle;
    };

    await writeFile(sessionPath, initialLine);

    try {
      const source = {
        totalTokens: 20_000,
        effectiveWindow: 178_808,
        fillPercent: 11,
        sessionPath
      } satisfies ContextUpdate;
      const first = await reconstructContextBreakdown(source, {
        workspaceRoot: root,
        homeDir: path.join(root, 'home'),
        now: () => 1_000
      });

      sessionReadLengths.length = 0;
      await appendFile(sessionPath, appendedLine);

      const cached = await reconstructContextBreakdown(
        {
          ...source,
          totalTokens: 20_100,
          fillPercent: 11.2
        },
        {
          workspaceRoot: root,
          homeDir: path.join(root, 'home'),
          now: () => 2_000
        }
      );

      assert.equal(first.categories.tools, TOKENS_PER_BUILTIN_TOOL);
      assert.equal(cached.categories.tools, TOKENS_PER_BUILTIN_TOOL);
      assert.equal(cached.totalTokens, 20_100);
      assert.equal(cached.fillPercent, 11.2);
      assert.equal(sessionReadLengths.at(-1), Buffer.byteLength(appendedLine));
      assert.ok(sessionReadLengths.every((length) => length <= 64 || length === Buffer.byteLength(appendedLine)));
    } finally {
      mutableFsPromises.open = originalOpen;
    }
  } finally {
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor reuses the cache for equivalent sources with different property order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-cache-key-'));
  clearAllContextCaches();

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
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor separates cache key fields with null bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-cache-separator-'));
  clearAllContextCaches();

  const mutableMapPrototype = Map.prototype as unknown as {
    set: (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown
    ) => Map<unknown, unknown>;
  };
  const originalSet = mutableMapPrototype.set;
  const cacheKeys: string[] = [];

  mutableMapPrototype.set = function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ): Map<unknown, unknown> {
    if (typeof key === 'string' && isContextCacheEntryValue(value)) {
      cacheKeys.push(key);
    }

    return originalSet.call(this, key, value);
  };

  try {
    const homeDir = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'repo|with-pipe');

    await reconstructContextBreakdown(
      {
        totalTokens: 5_000,
        effectiveWindow: 178_808,
        fillPercent: 3
      },
      {
        workspaceRoot,
        homeDir,
        now: () => 1_000
      }
    );

    assert.equal(cacheKeys.length, 1);
    assert.match(cacheKeys[0], /\0/);
    assert.match(cacheKeys[0], /repo\|with-pipe/);
  } finally {
    mutableMapPrototype.set = originalSet;
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor reuses cached CLAUDE.md snapshots when only the source changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-snapshot-cache-'));
  clearAllContextCaches();

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
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor invalidates when CLAUDE.md mtime changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-mtime-'));
  clearAllContextCaches();

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
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor keeps text file cache bounded to one entry per path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-text-cache-size-'));
  clearAllContextCaches();

  const homeDir = path.join(root, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, 'CLAUDE.md');
  await writeFile(claudePath, 'alpha');

  const mutableMapPrototype = Map.prototype as unknown as {
    set: (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown
    ) => Map<unknown, unknown>;
  };
  const originalSet = mutableMapPrototype.set;
  let textFileCacheMap: Map<unknown, unknown> | undefined;

  mutableMapPrototype.set = function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ): Map<unknown, unknown> {
    const result = originalSet.call(this, key, value);

    if (isCachedTextFileValue(value)) {
      textFileCacheMap = result;
    }

    return result;
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
    const secondChanged = new Date('2026-05-16T11:30:00Z');
    await utimes(claudePath, secondChanged, secondChanged);

    const second = await reconstructContextBreakdown(source, {
      homeDir,
      now: () => 2_000
    });

    await writeFile(claudePath, 'alpha beta gamma');
    const thirdChanged = new Date('2026-05-16T11:31:00Z');
    await utimes(claudePath, thirdChanged, thirdChanged);

    const third = await reconstructContextBreakdown(source, {
      homeDir,
      now: () => 3_000
    });

    assert.equal(first.categories.claudeMd, countTokens('alpha'));
    assert.equal(second.categories.claudeMd, countTokens('alpha beta'));
    assert.equal(third.categories.claudeMd, countTokens('alpha beta gamma'));
    assert.equal(textFileCacheMap?.size, 1);
  } finally {
    mutableMapPrototype.set = originalSet;
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor prunes expired cache entries on cache hits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-prune-hit-'));
  clearAllContextCaches();

  const homeDir = path.join(root, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  const workspaceRoot = path.join(root, 'repo', 'app');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'shared content');
  await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), 'workspace content');

  const mutableMapPrototype = Map.prototype as unknown as {
    delete: (this: Map<unknown, unknown>, key: unknown) => boolean;
  };
  const originalDelete = mutableMapPrototype.delete;
  let deleteCount = 0;

  mutableMapPrototype.delete = function (this: Map<unknown, unknown>, key: unknown): boolean {
    deleteCount += 1;
    return originalDelete.call(this, key);
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
      fillPercent: 4
    } satisfies ContextUpdate;

    await reconstructContextBreakdown(firstSource, {
      workspaceRoot,
      homeDir,
      now: () => 1_000
    });

    await reconstructContextBreakdown(secondSource, {
      workspaceRoot,
      homeDir,
      now: () => 50_000
    });

    deleteCount = 0;

    const cached = await reconstructContextBreakdown(secondSource, {
      workspaceRoot,
      homeDir,
      now: () => 61_000
    });

    assert.equal(cached.totalTokens, 6_000);
    assert.ok(deleteCount > 0);
  } finally {
    mutableMapPrototype.delete = originalDelete;
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor caches missing CLAUDE.md fingerprints between ticks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-fingerprint-cache-'));
  clearAllContextCaches();

  try {
    const homeDir = path.join(root, 'home');
    const claudeDir = path.join(homeDir, '.claude');
    const workspaceRoot = path.join(root, 'repo', 'a', 'b', 'c', 'd', 'workspace');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'shared content');
    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), 'workspace content');

    const mutableFsPromises = fsPromises as {
      stat: (...args: unknown[]) => Promise<unknown>;
    };
    const originalStat = mutableFsPromises.stat;
    let statCalls = 0;

    mutableFsPromises.stat = async (...args: unknown[]) => {
      statCalls += 1;
      return originalStat(...args);
    };

    try {
      const source = {
        totalTokens: 5_000,
        effectiveWindow: 178_808,
        fillPercent: 3
      } satisfies ContextUpdate;

      await reconstructContextBreakdown(source, {
        workspaceRoot,
        homeDir,
        now: () => 1_000
      });
      const afterFirst = statCalls;

      await reconstructContextBreakdown(source, {
        workspaceRoot,
        homeDir,
        now: () => 2_000
      });
      const afterSecond = statCalls;

      const firstIncrement = afterFirst;
      const secondIncrement = afterSecond - afterFirst;

      assert.ok(firstIncrement > 4);
      assert.ok(secondIncrement < firstIncrement);
      assert.ok(secondIncrement <= 4);
    } finally {
      mutableFsPromises.stat = originalStat;
    }
  } finally {
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor prunes expired missing CLAUDE.md fingerprints on cache hits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-fingerprint-prune-'));
  clearAllContextCaches();

  try {
    const homeDir = path.join(root, 'home');
    const claudeDir = path.join(homeDir, '.claude');
    const workspaceRoot = path.join(root, 'repo', 'a', 'b', 'c', 'd', 'workspace');
    const workspaceClaude = path.join(workspaceRoot, 'CLAUDE.md');
    const homeClaude = path.join(claudeDir, 'CLAUDE.md');

    await mkdir(claudeDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(homeClaude, 'shared content');
    await writeFile(workspaceClaude, 'workspace content');

    const mutableMapPrototype = Map.prototype as unknown as {
      delete: (this: Map<unknown, unknown>, key: unknown) => boolean;
    };
    const originalDelete = mutableMapPrototype.delete;
    let missingFingerprintDeletes = 0;

    mutableMapPrototype.delete = function (this: Map<unknown, unknown>, key: unknown): boolean {
      if (
        typeof key === 'string' &&
        key.endsWith('CLAUDE.md') &&
        key !== workspaceClaude &&
        key !== homeClaude
      ) {
        missingFingerprintDeletes += 1;
      }

      return originalDelete.call(this, key);
    };

    try {
      const sourceWithMissingFingerprints = {
        totalTokens: 5_000,
        effectiveWindow: 178_808,
        fillPercent: 3
      } satisfies ContextUpdate;
      const sourceWithoutWorkspace = {
        effectiveWindow: 178_808,
        fillPercent: 3
      } satisfies ContextUpdate;

      await reconstructContextBreakdown(sourceWithMissingFingerprints, {
        workspaceRoot,
        homeDir,
        now: () => 1_000
      });

      await reconstructContextBreakdown(sourceWithoutWorkspace, {
        homeDir,
        now: () => 50_000
      });

      missingFingerprintDeletes = 0;

      await reconstructContextBreakdown(sourceWithoutWorkspace, {
        homeDir,
        now: () => 61_000
      });

      assert.ok(missingFingerprintDeletes > 0);
    } finally {
      mutableMapPrototype.delete = originalDelete;
    }
  } finally {
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructor shares in-flight work for concurrent calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-inflight-'));
  clearAllContextCaches();

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
    clearAllContextCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanImportPath strips trailing closing bracket', () => {
  assert.equal(cleanImportPath('./rules.md]'), './rules.md');
});

test('cleanImportPath strips trailing closing brace', () => {
  assert.equal(cleanImportPath('./rules.md}'), './rules.md');
});

test('cleanImportPath strips trailing double quote', () => {
  assert.equal(cleanImportPath('./rules.md"'), './rules.md');
});

test('cleanImportPath strips trailing single quote', () => {
  assert.equal(cleanImportPath("./rules.md'"), './rules.md');
});

test('cleanImportPath strips trailing greater-than sign', () => {
  assert.equal(cleanImportPath('./rules.md>'), './rules.md');
});

test('cleanImportPath leaves clean import path unchanged', () => {
  assert.equal(cleanImportPath('./rules.md'), './rules.md');
});

test('cleanImportPath strips combined trailing punctuation', () => {
  assert.equal(cleanImportPath('./rules.md]).'), './rules.md');
});

async function readFileText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

function isCachedTextFileValue(value: unknown): value is {
  readonly fingerprint: string;
  readonly content: string;
  readonly tokenCount: number;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    readonly fingerprint?: unknown;
    readonly content?: unknown;
    readonly tokenCount?: unknown;
  };

  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.tokenCount === 'number'
  );
}

function isCachedToolSetValue(value: unknown): value is {
  readonly offset: number;
  readonly remainder: string;
  readonly tools: ReadonlySet<string>;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    readonly offset?: unknown;
    readonly remainder?: unknown;
    readonly tools?: unknown;
  };

  return (
    typeof candidate.offset === 'number' &&
    typeof candidate.remainder === 'string' &&
    candidate.tools instanceof Set
  );
}

function isContextCacheEntryValue(value: unknown): value is {
  readonly key: string;
  readonly expiresAt: number;
  readonly value: { readonly isEstimate: true };
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    readonly key?: unknown;
    readonly expiresAt?: unknown;
    readonly value?: { readonly isEstimate?: unknown };
  };

  return (
    typeof candidate.key === 'string' &&
    typeof candidate.expiresAt === 'number' &&
    candidate.value?.isEstimate === true
  );
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

function padJsonlLineToByteLength(lineText: string, byteLength: number): string {
  const paddingBytes = byteLength - Buffer.byteLength(lineText);

  assert.ok(paddingBytes >= 0);

  return `${lineText}${' '.repeat(paddingBytes)}\n`;
}

function flipWindowsDriveLetterCase(filePath: string): string {
  if (!/^[a-z]:/i.test(filePath)) {
    return filePath;
  }

  const driveLetter = filePath[0];
  const flippedDriveLetter =
    driveLetter === driveLetter.toUpperCase() ? driveLetter.toLowerCase() : driveLetter.toUpperCase();

  return `${flippedDriveLetter}${filePath.slice(1)}`;
}
