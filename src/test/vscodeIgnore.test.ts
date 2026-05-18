import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cwd } from 'node:process';

test('.vscodeignore excludes non-runtime artifacts from the published package', async () => {
  const ignore = await readFile(path.join(cwd(), '.vscodeignore'), 'utf8');

  assert.match(ignore, /\.claudeignore/);
  assert.match(ignore, /\.github\//);
  assert.match(ignore, /CLAUDE\.md/);
  assert.match(ignore, /package-lock\.json/);
  assert.match(ignore, /out\//);
  assert.match(ignore, /src\//);
});
