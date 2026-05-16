# CLAUDE.md – vscode-claude-context

VSCode extension that shows the **current Claude Code context window composition** in the editor:
traffic-light status bar item + breakdown panel (tokens by category: system prompt, tools, memory, conversation).

Differentiation from `long-kudo/vscode-claude-status`: that extension tracks historical costs from JSONL logs.
This extension shows the **live context state** — what is consuming tokens right now.

**CLAUDE.md size rule:** Keep ≤ ~120 lines. Sections > ~15 lines → extract to `docs/` + link here.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.x |
| Runtime | VSCode Extension API |
| Build | webpack / esbuild |
| Test | Mocha + `@vscode/test-electron` |
| Lint | ESLint + `@typescript-eslint` |
| Package | `@vscode/vsce` |

---

## Architecture decisions (locked)

| Question | Decision |
|----------|----------|
| Data source | TBD — core open question: how to read `/context` output into extension |
| Status bar | Lightweight, no blocking I/O on main thread |
| File paths | Always `os.homedir()` equivalents — no hardcoded paths |
| Storage | No `localStorage`/`sessionStorage` in WebView |
| Polling rate | Max once per 5 s when active, none when Claude Code idle |

→ Architecture details, data source options: [docs/architecture.md](docs/architecture.md)

---

## Dev setup

```bash
npm install       # install deps
npm run compile   # TypeScript build
npm run watch     # watch mode
```

Press **F5** in VSCode to launch Extension Development Host.

→ First-time setup, env vars, known issues: [docs/dev-setup.md](docs/dev-setup.md)

---

## Git workflow

- **Branch:** `feat/{issue-number}-{slug}` · `fix/` · `docs/` · `chore/`
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`)
- **PRs:** One issue per PR. No direct push to `main`.
- **Language:** English (code, commits, docs, PR titles)

---

## Forbidden patterns

1. **No hardcoded paths.** Always `os.homedir()` or VS Code API equivalents.
2. **No blocking I/O** on the extension host main thread.
3. **No `localStorage`/`sessionStorage`** in WebView — use VS Code message passing.
4. **No polling faster than 5 s** when Claude Code is active; pause when idle.
5. **No direct push to `main`.** Always feature branch + PR.
6. **No scope creep.** Context window display only — not cost tracking, not history.

---

## Role split

| Task | Owner |
|------|-------|
| Architecture, data source decision, CLAUDE.md | Claude Code |
| PR review, release | Claude Code |
| Issue spec | Claude Code writes; GPT/Codex implements |
| TypeScript implementation | GPT/Codex |

**Time-boxing:** Not solved in ~3 min → GitHub Issue → delegate. Don't retry in a loop.

### PR review checklist

- [ ] No hardcoded paths
- [ ] No blocking I/O on main thread
- [ ] No `localStorage`/`sessionStorage` in WebView
- [ ] Polling respects 5 s minimum + idle pause
- [ ] No scope creep beyond the issue
- [ ] TypeScript: no unexplained `any`
- [ ] Conventional Commit message

→ Review-Workflow details: [docs/review-process.md](docs/review-process.md)

---

## Cross-references

- Baseline to differentiate from: [long-kudo/vscode-claude-status](https://github.com/long-910/vscode-claude-status)
- LLM workflow blueprint: `infra-ref/llm-repo-blueprint.md`
- Backlog: GitHub Issues in this repo only
