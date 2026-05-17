'use strict';
const { readdirSync } = require('fs');
const { join, resolve } = require('path');
const { spawnSync } = require('child_process');

const testDir = resolve(__dirname, '../../out/test-dist/test');
const setup = resolve(__dirname, 'test-setup.cjs');

const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => join(testDir, f));

const result = spawnSync(process.execPath, ['-r', setup, '--test', ...files], {
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
