# Architecture

## Data source: JSONL tailing

The extension reads Claude Code's JSONL session files from `~/.claude/projects/`. Each file records turns as newline-delimited JSON. The extension tails the active session file and reconstructs the context breakdown from the token usage fields in each turn.

No terminal interception, no VS Code API hooking, no network calls for context data.

## Data flow

```text
~/.claude/projects/<slug>/<session>.jsonl
        │
        ▼
JsonlTailDataSource          ← tails JSONL, emits ContextSnapshot on change
        │
        ├──► StatusBarController   ← renders traffic-light status bar item
        │
        └──► BreakdownPanel        ← renders token breakdown in WebView
                    │
                    ├──► HistoricalUsageReader   ← scans all JSONL for 5h/7d token totals
                    └──► RateLimitReader         ← optional: probes Anthropic API for rate-limit headers
```

## Source layout

```text
src/
  extension.ts                  ← activate/deactivate, wires all components
  statusBar.ts                  ← traffic-light status bar item + rate-limit timer
  statusBarFormatting.ts        ← label/tooltip formatting helpers
  contextReconstructor.ts       ← parses JSONL turns into ContextSnapshot
  dataSource/
    jsonlTail.ts                ← JSONL tail, session lock detection, FSWatcher
    historicalUsage.ts          ← scans all projects for 5h/7d token buckets
    rateLimit.ts                ← Anthropic API probe for rate-limit headers
  webview/
    panel.ts                    ← BreakdownPanel lifecycle, postSnapshot
    dashboard.html              ← WebView HTML template (CSP-strict, nonce'd)
```

## Status bar thresholds

| Context fill | Color | ThemeColor |
|-------------|-------|------------|
| < 40 % | green | *(default)* |
| 40–60 % | yellow | `statusBarItem.warningBackground` |
| ≥ 60 % | red | `statusBarItem.errorBackground` |

## Key decisions

| Question | Decision |
|----------|----------|
| Data source | JSONL tail (`~/.claude/projects/`) — local, no network |
| Session detection | Lock files in `~/.claude/ide/` identify the active project |
| Token counting | `gpt-tokenizer` approximation for CLAUDE.md imports |
| Polling | Max once per 5 s when active; idle detection via `whenIdle()` |
| WebView storage | VS Code message passing only — no `localStorage`/`sessionStorage` |
| Historical usage | Optional API probe (`showHistoricalUsage: false` by default) |
