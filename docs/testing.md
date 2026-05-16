# Testing

## Stack

Mocha + `@vscode/test-electron`

## Run

```bash
npm test
```

## What to test

- Context data parsing logic (unit — no VSCode API needed)
- Status bar color thresholds
- WebView message serialization/deserialization

## What NOT to mock

The data source layer (once decided) should be tested against real output, not mocked — mock/real divergence is the main failure mode for this type of extension.
