# Changelog

All notable changes to the Claude Context Monitor extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-25

### Added

- **Status bar placement settings.** `claudeContext.statusBar.alignment` (`"left"` | `"right"`, default `"left"`) and `claudeContext.statusBar.priority` (number, default `100`) let you move the indicator to either side of the status bar and position it relative to other items — for example next to another assistant's icon. VS Code fixes an item's alignment and priority at creation time, so both settings take effect immediately by recreating the item; no window reload is needed. Defaults reproduce the previous placement exactly. (#221, #223 — thanks @aquilaRoss)
- A manual-trigger **VSIX Artifact** workflow that packages a `.vsix` and uploads it as a downloadable build artifact, so you can grab a build without waiting on a Marketplace release. Its test matrix is shared with CI through a reusable workflow so the two cannot drift apart. (#223 — thanks @aquilaRoss)

### Fixed

- **Workspaces whose path contains a non-ASCII character showed `ctx idle` forever.** The project-slug algorithm replaced only `:`, path separators and whitespace runs, while Claude Code replaces every character outside `[A-Za-z0-9]` individually. Any path containing an umlaut or accent therefore resolved to a directory that does not exist, no session was found, and the status bar never recovered. Whitespace runs are no longer collapsed either, matching Claude Code's per-character replacement. (#211, #227)
- **Claude Opus 5 is now pinned in the model table** at the values Claude Code registers for it — a 1M context window and a 64k default output budget — instead of falling through to the Opus family fallback's 32k budget. This slightly raises the reported fill percentage for Opus 5 sessions. (#224, #226)
- `claudeContext.statusBar.priority` is no longer clamped to `0..1000`. The VS Code API accepts any number, and a low or negative priority is the only way to place the indicator at the inner edge of its side. The clamp rewrote the value silently, which made the setting look broken. (#225, #229)

### Documentation

- The model table now records that the 1M context window is a default users can opt out of — when they do, the window is overstated and the reported fill reads low — and that `maxOutputTokens` holds Claude Code's default output budget rather than the API ceiling. (#228)
- `docs/architecture.md` documents that project-directory slugs mirror Claude Code's lossy mapping: distinct workspace paths can collide and select the wrong session, but no source data is ever modified. (#211, #227)

## [0.1.2] - 2026-07-06

### Fixed

- Corrected the Claude Code context windows in the model table. (#219)

### Documentation

- The PR review checklist now requires new or changed model-table context windows to be re-verified against the current Claude Code changelog rather than copied from a neighbouring row. (#218, #220)

## [0.1.1] - 2026-07-06

### Added

- Context window limits for Sonnet 5, Opus 4.8 and Fable 5. (#217)
- `claudeContext.showTotalFill` setting, `showHistoricalUsage` enabled by default, and a reload button in the breakdown panel. (#216)

### Changed

- Marketplace publisher renamed to `KorbinianSlavik`. Installations carrying the old `komisla.vscode-claude-context` identifier no longer receive updates and must be reinstalled.

## 0.1.0

Initial Marketplace release, published before release tagging was introduced — no `v0.1.0` tag exists.

### Added

- Initial release: traffic-light status bar indicator for the live Claude Code context window, a breakdown panel showing tokens by category (system prompt, tools, memory, conversation), and 5h / 7d plan utilization as supporting context.

[0.2.0]: https://github.com/komisla/vscode-claude-context/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/komisla/vscode-claude-context/compare/v0.1.1...v0.1.2
