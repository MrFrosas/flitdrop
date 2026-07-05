# Security Policy

Flitdrop moves your files and clipboard between devices, so we take security seriously. Thank you for helping keep it safe.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue.

- Preferred: open a private security advisory on GitHub, at [github.com/MrFrosas/flitdrop/security/advisories/new](https://github.com/MrFrosas/flitdrop/security/advisories/new).
- Or email the maintainer at thomasbidault.tb@gmail.com with the details.

Please include what you found, the steps to reproduce it, the affected version, and, if you can, a suggested fix. We will acknowledge your report as quickly as we can and keep you posted while we work on it. Please give us a reasonable window to release a fix before any public disclosure.

## Scope

In scope:

- The desktop app (the local server, pairing, and encryption).
- The phone-side web interface served by the app.
- The transfer protocol and clipboard sync.

Out of scope:

- The marketing website and documentation content.
- Issues that require physical access to an already unlocked machine.
- Reports produced only by automated scanners with no demonstrated impact.

## A note on code signing

Be aware that the desktop app is not yet code-signed. On Windows, SmartScreen shows an "unknown publisher" prompt on first run; on macOS, the build is ad-hoc signed but not yet notarized, so the system may block the first launch. This is expected for now and will change with the signed Store versions. It also means you should only download Flitdrop from the official [releases page](https://github.com/MrFrosas/flitdrop/releases/latest).
