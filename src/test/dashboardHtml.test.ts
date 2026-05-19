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
  assert.match(html, /system prompt constant may be outdated/);
  assert.match(html, /conversation tokens were clamped/);
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
  assert.match(html, /GPT-tokenizer approximation/);
});

test('dashboard shows an initial loading state before context arrives', async () => {
  const html = await readDashboardHtml();

  assert.match(
    html,
    /<p id="empty-state" class="empty muted loading" role="status" aria-live="polite">Loading\.\.\.<\/p>/
  );
  assert.match(html, /\.empty\.loading::after/);
  assert.match(html, /@keyframes loading-slide/);
  assert.match(html, /emptyState\.classList\.remove\('loading'\)/);
  assert.match(html, /Waiting for context data\./);
});

test('dashboard relies on VS Code message passing instead of webview storage', async () => {
  const html = await readDashboardHtml();

  assert.equal(html.includes('localStorage'), false);
  assert.equal(html.includes('sessionStorage'), false);
  assert.match(html, /vscode\.postMessage/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'ready' \}\)/);
  assert.match(html, /window\.addEventListener\('message'/);
  assert.match(html, /event\.data\?\.type === 'contextSnapshot'/);
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

test('dashboard total line shows usable fill and raw bar is driven by showTotalFill', async () => {
  const html = await readDashboardHtml();

  assert.match(html, /usable tokens \(\$\{Math\.round\(fillPercent\)\}%\)/);
  assert.match(html, /breakdown\.totalTokens \/ breakdown\.contextWindow/);
  assert.match(html, /total-fill-section/);
  assert.equal(html.includes('effective tokens'), false);
});
