# Synthetic GUI regression tests

These tests exercise the actual JavaScript of the G Nexus page in jsdom. The
backend, two-window transport, window close and device state are test doubles;
no G Nexus app, real profile, Tauri/WebView2 process, device or native input
injector is opened. Passing them does not establish native Windows behaviour.

```sh
cd tests/gui-regressions
npm ci --ignore-scripts --no-audit --no-fund
node macro-cases.cjs
node close-cases.cjs
node close-mouse-draft.cjs
```

To run against a different UI tree, pass its path as the first argument.
`ONLY=substring` selects a named test. Several known limitations of the
experiment remain (forced destruction, external writers and multi-file crash
atomicity); these tests do not establish complete protection for other devices.
