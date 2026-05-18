import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cwd } from 'node:process';
import { spawnSync } from 'node:child_process';

test('.vscodeignore excludes non-runtime artifacts from the published package', async () => {
  const ignore = await readFile(path.join(cwd(), '.vscodeignore'), 'utf8');

  assert.match(ignore, /\.claudeignore/);
  assert.match(ignore, /\*\*\/\.github\/\*\*/);
  assert.match(ignore, /CLAUDE\.md/);
  assert.match(ignore, /package-lock\.json/);
  assert.match(ignore, /\*\*\/out\/\*\*/);
  assert.match(ignore, /\*\*\/src\/\*\*/);
  assert.doesNotMatch(ignore, /^\*\*\/dist\/\*\*/m);
});

test('vsce package file list excludes repository and test artifacts', () => {
  const vsce = path.join(cwd(), 'node_modules', '@vscode', 'vsce', 'vsce');
  const result = spawnSync(process.execPath, [vsce, 'ls'], {
    cwd: cwd(),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);

  const files = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const listed = files.join('\n');

  assert.doesNotMatch(listed, /(^|\/)out\//);
  assert.doesNotMatch(listed, /(^|\/)test-dist2?\//);
  assert.doesNotMatch(listed, /(^|\/)src\//);
  assert.doesNotMatch(listed, /(^|\/)CLAUDE\.md$/m);
  assert.doesNotMatch(listed, /(^|\/)\.github\//);
});
