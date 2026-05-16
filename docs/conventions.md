# Conventions

## TypeScript

- Strict mode on (`"strict": true` in tsconfig)
- No `any` without explicit comment explaining why
- Prefer `const`, avoid `let` where possible
- Named exports preferred over default exports

## Naming

- Files: `camelCase.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`

## VSCode Extension specifics

- All disposables registered in `context.subscriptions`
- No synchronous file I/O on the extension host thread
- WebView messages typed with discriminated unions
