# Publishing

## VS Marketplace

```bash
npm run package    # builds .vsix
vsce publish       # publishes to Marketplace (requires PAT)
```

Publisher ID: TBD (set up at https://marketplace.visualstudio.com/manage)

## `.vscodeignore`

Controls what goes into the `.vsix` package. This repo keeps only runtime files (`dist/`, `package.json`, `README.md`, and `LICENSE` if present) and excludes source, tests, docs, editor config, and Claude workspace files.

## Release checklist

- [ ] `CHANGELOG.md` updated
- [ ] Version bumped in `package.json`
- [ ] `npm test` passes
- [ ] `npm run package` produces a working `.vsix`
- [ ] GitHub release tag created
