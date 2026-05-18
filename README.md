# Claude Context Monitor

Live view of your Claude Code context window — right in the VS Code status bar.

Claude Context Monitor adds a traffic-light status bar item that shows how full the current Claude Code context window is, plus a breakdown panel that explains *what* is consuming those tokens (system prompt, tools, memory, conversation). All context data is read locally from Claude Code's session files — no network calls.

<!-- screenshot -->

## Features

### Status bar indicator

- Always-visible traffic light: green below 40% fill, yellow 40–60%, red at 60% or higher
- Compact display: `$(hubot) ctx 42%`
- Optional plan utilization next to the fill: `$(hubot) ctx 42%  5h 31%  7d 18%`
- Configurable threshold to hide the item below a given fill %

### Breakdown panel

Open via the command **Claude Context: Open Breakdown Panel**.

- Progress bar with both *usable* fill and raw context-window fill
- Token breakdown by category: System prompt, Tools, Memory, Conversation
- Per-model token breakdown
- Compact token counts (e.g. `12.3k`) with copy-to-clipboard
- Plan rate-limit utilization (Last 5h / Last 7d), when enabled
- Collapsible info section: *How context fill affects response quality*
- One-click **Start new Claude Code chat** button
- Loading state while session data is read

### Data source

The extension tails Claude Code's JSONL session files in `~/.claude/projects/`. The core context-window feature makes **no network calls** — your conversation data never leaves your machine.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `claudeContext.hideBelow` | number | `0` | Hide the status bar item when fill % is below this value. `0` keeps it always visible. |
| `claudeContext.showHistoricalUsage` | boolean | `false` | Enable plan utilization (5h / 7d) in the status bar and panel. |

### Note on `showHistoricalUsage`

This option is **opt-in**. When enabled, the extension sends one `POST` request to `api.anthropic.com` every 5 minutes using your stored Claude OAuth token to fetch your rate-limit utilization. These requests count against your Claude API usage. Leave the setting off if you don't want the extension to make any network calls.

## Requirements

- VS Code 1.85 or later
- [Claude Code](https://docs.claude.com/claude-code) installed, with at least one active session

## Usage

1. Install the extension.
2. Start (or resume) a Claude Code session in any project.
3. The status bar item appears automatically and updates as the conversation grows.
4. Click the item, or run **Claude Context: Open Breakdown Panel** from the command palette, to see the full breakdown.

## Source & issues

Source code, issue tracker and changelog: <https://github.com/komisla/vscode-claude-context>

## Related

- [long-kudo/vscode-claude-status](https://github.com/long-910/vscode-claude-status) — tracks historical **cost** (dollar amounts) from Claude Code logs. Claude Context Monitor instead shows the **live context state**: what is consuming tokens in the current session, right now.
