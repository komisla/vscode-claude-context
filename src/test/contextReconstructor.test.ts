import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { cwd } from 'node:process';
import path from 'node:path';
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

test('counts workspace, parent, global CLAUDE.md files and one-level imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-context-reconstruct-'));

  try {
    const homeDir = path.join(root, 'home');
    const globalClaudeDir = path.join(homeDir, '.claude');
    const workspaceRoot = path.join(root, 'repo', 'app');
    const absoluteImportDir = path.join(cwd(), `.test-abs-${path.basename(root)}`);
    const absoluteImportPath = path.join(absoluteImportDir, 'abs-import.md');
    const absoluteImportRef = absoluteImportPath
      .slice(path.parse(absoluteImportPath).root.length)
      .replace(/\\/g, '/');
    await mkdir(globalClaudeDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(absoluteImportDir, { recursive: true });

    const globalClaude = 'global rules @global-import.md';
    const globalImport = 'global imported';
    const parentClaude = 'parent rules @parent-import.md\nRepo @long-kudo/vscode-claude-status';
    const parentImport = 'parent imported';
    const workspaceClaude = `workspace rules @./workspace-import.md @../parent-import.md @~/home-import.md @/${absoluteImportRef} @missing.md\nEmail slavik@korbinian.eu\nPackage @types/node`;
    const workspaceImport = 'workspace imported @nested.md';
    const homeImport = 'home imported';
    const absoluteImport = 'absolute imported';
    const nestedImport = 'nested should not be followed';
    const repoReference = 'repo reference should not be imported';
    const npmPackage = 'package should not be imported';

    await writeFile(path.join(globalClaudeDir, 'CLAUDE.md'), globalClaude);
    await writeFile(path.join(globalClaudeDir, 'global-import.md'), globalImport);
    await writeFile(path.join(root, 'repo', 'CLAUDE.md'), parentClaude);
    await writeFile(path.join(root, 'repo', 'parent-import.md'), parentImport);
    await writeFile(path.join(homeDir, 'home-import.md'), homeImport);
    await writeFile(absoluteImportPath, absoluteImport);
    await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), workspaceClaude);
    await writeFile(path.join(workspaceRoot, 'workspace-import.md'), workspaceImport);
    await writeFile(path.join(workspaceRoot, 'nested.md'), nestedImport);
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
      parentImport,
      homeImport,
      absoluteImport,
      workspaceImport
    ].reduce((sum, content) => sum + countTokens(content), 0);

    assert.equal(await countClaudeMdTokens(workspaceRoot, homeDir), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(path.join(cwd(), `.test-abs-${path.basename(root)}`), {
      recursive: true,
      force: true
    });
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
  assert.equal(breakdown.isEstimate, true);
  assert.equal(breakdown.fillPercent, 1);
});

test('reconstructor caches for 30 seconds and invalidates when source changes', async () => {
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
    assert.equal(cached.categories.tools, TOKENS_PER_BUILTIN_TOOL);
    assert.equal(invalidated.categories.tools, TOKENS_PER_BUILTIN_TOOL * 2);
  } finally {
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
