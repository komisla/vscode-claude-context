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

## MODEL_TABLE numeric claims decay — re-verify, don't copy

Issue #218 (`fix: update Claude Code context windows`, merged after 0.1.1 shipped it wrong)
happened because a locked-in assumption — "Claude Code's effective context window is 200K for
all Claude 4.x models" — was extended to newer model IDs (Sonnet 5, Opus 4.8, Fable 5) by
copying the existing table row shape, instead of re-checking whether the claim still held for
those specific models. It didn't: Sonnet 5, Opus 4.6+, and Fable 5/Mythos 5 use a native 1M
window in Claude Code. Review didn't catch it either, because the checklist only covered
structural concerns (paths, blocking I/O, scope), not "is this factual claim still true."

**Rule:** any PR adding or changing a `MODEL_TABLE` entry must cite a *current* source for the
context window — the Claude Code changelog (`anthropics/claude-code` CHANGELOG.md) or an
equivalent up-to-date reference — not the neighboring row or a prior code comment. A model's
context window is a fact with a shelf life, not a constant to inherit.
