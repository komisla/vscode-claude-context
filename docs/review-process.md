# Review Process

## Workflow

1. Korbinian writes issue spec with Claude Code
2. GPT/Codex implements → opens PR
3. PR report copied to Claude Code → review starts
4. Claude Code checks diff against PR checklist in CLAUDE.md
5. Single-line fixes: applied directly. Logic/architecture/> 5 lines: flagged as issue comment.
6. Claude Code is sole merge gatekeeper.

## Opus deep-review triggers

Trigger a deep review (Opus) when:
- Data source layer changes
- WebView message protocol changes
- Any change touching polling/throttle logic
- First implementation of a new feature
