# Contributing to Flitdrop

Thanks for taking the time to help. Flitdrop is a small, focused project and contributions are welcome, from a typo fix to a new feature.

## Build and run

You need Node.js 20 or newer.

```bash
npm install
npm run dev        # local server + interfaces (port 47777)
npm run desktop    # desktop app (window + tray icon)
```

## Run the tests

```bash
npm test           # crypto, protocol, resume, security, clipboard history
```

Please make sure the tests pass before you open a pull request. If you add behaviour, add a test for it.

## Conventions

- **No em-dash or en-dash anywhere.** In English and in French, use a comma, a colon, a period, or parentheses instead. This applies to code, docs, commit messages, and UI copy.
- **French must read natively.** If you touch French text, keep proper accents and apostrophes and write it the way a native speaker would.
- **i18n key parity.** Every user-facing string lives under a key in both English and French. When you add or rename a key, add or rename it in both languages so the two stay in sync.
- Keep changes small and focused. One idea per pull request is easier to review.

## Filing issues and pull requests

- **Bugs and feature ideas:** open an issue using the templates (Bug report or Feature request). The more detail, the faster we can help, especially your OS, your Flitdrop version, and, for phone-side bugs, the phone and browser.
- **Pull requests:** fork, create a branch, make your change, run the tests, then open the PR with a short description of what and why. Link the issue it addresses if there is one.
- **Security:** please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License of contributions

Flitdrop is released under the Functional Source License (FSL-1.1-ALv2). By submitting a contribution, you agree that it is licensed under those same terms.
