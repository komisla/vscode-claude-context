import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cwd } from 'node:process';

async function readDashboardHtml(): Promise<string> {
  return readFile(path.join(cwd(), 'src', 'webview', 'dashboard.html'), 'utf8');
}

test('dashboard includes issue 4 research links and heuristic wording', async () => {
  const html = await readDashboardHtml();

  assert.match(html, /How context fill affects response quality/);
  assert.match(html, /quality heuristics, not Anthropic product limits/);
  assert.match(html, /system prompt constants are out of date/);
  assert.match(html, /No active Claude Code session detected\./);
  assert.match(html, /https:\/\/arxiv\.org\/abs\/2307\.03172/);
  assert.match(html, /https:\/\/arxiv\.org\/abs\/2502\.05167/);
  assert.match(
    html,
    /https:\/\/www\.anthropic\.com\/engineering\/effective-context-engineering-for-ai-agents/
  );
  assert.match(
    html,
    /https:\/\/support\.claude\.com\/en\/articles\/14552983-models-usage-and-limits-in-claude-code/
  );
  assert.match(html, /used_percentage = input_tokens \+[\s\S]*cache_creation \+ cache_read/);
});

test('dashboard relies on VS Code message passing instead of webview storage', async () => {
  const html = await readDashboardHtml();

  assert.equal(html.includes('localStorage'), false);
  assert.equal(html.includes('sessionStorage'), false);
  assert.match(html, /vscode\.postMessage/);
  assert.match(html, /window\.addEventListener\('message'/);
});

test('dashboard declares a strict CSP with a script nonce placeholder', async () => {
  const html = await readDashboardHtml();

  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src 'unsafe-inline'/);
  assert.match(html, /script-src 'nonce-\{\{nonce\}\}'/);
  assert.match(html, /<script nonce="\{\{nonce\}\}">/);
  assert.equal(html.includes("script-src 'unsafe-inline'"), false);
});
