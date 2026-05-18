# Testing

## Stack

`node:test` (Node.js built-in test runner) — no Mocha, no `@vscode/test-electron`.

Tests run against compiled output in `out/test-dist/`. The VS Code API is shimmed by `src/test/test-setup.cjs` so tests execute in plain Node without an Extension Development Host.

## Run

```bash
npm test
```

This compiles (`webpack`), type-checks (`tsc --outDir out/test-dist`), then runs all `*.test.js` files via `node --test`.

## Test files

| File | What it covers |
|------|---------------|
| `contextReconstructor.test.ts` | CLAUDE.md import counting, JSONL reconstruction, cache invalidation |
| `jsonlTail.test.ts` | Fill-percent calculation, model limits, JSONL parsing, FSWatcher, session detection |
| `historicalUsage.test.ts` | Historical JSONL scanning, 5h/7d bucketing, directory cache, timestamp parsing |
| `statusBar.test.ts` | Status bar thresholds, rate-limit timer start/stop |
| `panel.test.ts` | BreakdownPanel snapshot posting, throttle, dispose |
| `extension.test.ts` | Activation wiring, prewarm call |
| `dashboardHtml.test.ts` | WebView HTML invariants (CSP, storage, loading state) |
| `vscodeIgnore.test.ts` | `.vscodeignore` patterns + `vsce ls` packaging verification |
| `slugify.test.ts` | Project path → slug conversion |

## What is NOT mocked

The JSONL reader is tested against real temp files written during each test run. The VS Code API (`vscode.*` calls) is shimmed with a minimal mock that tracks subscriptions and configuration reads — not full VS Code.
