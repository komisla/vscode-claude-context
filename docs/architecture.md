# Architecture

## Core question: data source

The extension needs to know the current Claude Code context window breakdown (tokens by category).

Options to evaluate:
- **Parse `/context` terminal output** — watch Claude Code's stdout/stderr via a PTY or terminal integration
- **Read a file** — check if Claude Code writes context state to `~/.claude/` (e.g. alongside JSONL logs)
- **VSCode API hook** — intercept Claude Code extension output channel
- **Polling `~/.claude/` state files** — if any reflect current session context

Decision: TBD — evaluate in first implementation issue.

## Components (planned)

```text
src/
  extension.ts        ← activate/deactivate, register commands
  statusBar.ts        ← traffic-light status bar item
  contextReader.ts    ← data source abstraction (TBD)
  webview/
    panel.ts          ← breakdown panel lifecycle
    dashboard.html    ← panel HTML template
```

## Status bar behavior

| Context fill | Color | Label |
|-------------|-------|-------|
| < 60 % | green | `ctx 42%` |
| 60–75 % | yellow | `ctx 68%` |
| > 75 % | red | `ctx 81%` |
