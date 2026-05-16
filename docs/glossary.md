# Glossary

**Context window** — the total token budget available to Claude Code in a session. Made up of system prompt, tools, memory files, skills, and conversation history.

**Context fill level** — percentage of the context window currently used. Shown as a number (e.g. 68%) in the status bar.

**Breakdown** — token usage split by category (system prompt, tools, memory, conversation). Shown in the detail panel.

**Traffic light** — green/yellow/red color coding of the status bar item based on fill level thresholds (< 60 % / 60–75 % / > 75 %).

**JSONL logs** — `~/.claude/projects/**/*.jsonl` files written by Claude Code containing session history. Used by long-kudo for cost tracking. May or may not be the data source for this extension.
