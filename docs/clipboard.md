# Clipboard sync: the truth (verified audit, July 2026)

The core question: "I copy a message on my iPhone, does it paste itself on the PC, like Apple's Universal Clipboard?"

Short answer, verified against Apple and Android's own docs: **no, not automatically from the phone to the PC, and this is not a Flitdrop limitation. It is an OS-level lock that no third-party app can bypass, even a native one.**

## Why fully automatic phone-to-PC is impossible for anyone

Apple's Universal Clipboard works automatically because it is a **system service** (Continuity), reserved to Apple devices on the same iCloud account. Apple opens it to no third party. Every clipboard tool on the market hit this same wall: Clipt, Pushbullet, SwiftKey, KDE Connect.

- **iPhone.** Since iOS 9, an app can only read the clipboard while it is open in the foreground. In the background it reads nothing. Since iOS 16, even a foreground read shows the "Paste from other apps" prompt. There is no "on copy" trigger in Shortcuts. So from an iPhone: **one tap** (Action Button, Shortcut), never automatic.
- **Android.** Since Android 10, only the foreground app or the default keyboard can read the clipboard. A background service cannot. So: **one tap** (a tile, a notification) or "be the keyboard" for near-automatic.
- **Computer (Windows/Mac).** No restriction: the computer can watch its own clipboard continuously, on its own.

## What is actually automatic, and what needs one tap

| Direction | iPhone | Android | Computer |
|---|---|---|---|
| **Phone → computer** | one tap | one tap (or keyboard) | receives on its own |
| **Computer → phone** | **automatic on the computer side**, phone gets it in "Receive" | **automatic on the computer side** | **pushes on its own** |

## What Flitdrop ships today

- **Computer → phone, automatic.** A "sync my clipboard" setting: whatever you copy on the computer becomes available on the phone with no action. Tested end to end, with de-duplication and an anti-loop guard.
- **Phone → computer, one tap.** The "Text" tab sends the clipboard in one tap; the Apple Shortcut does the same from the iPhone Action Button.
- **Clipboard history**, like the Paste app, on the computer: everything copied is kept locally (never sent to any server), searchable, one click to copy again or push to the phone. Retention is configurable by count and by age.

## What a native app would add (and never add)

A native app makes the "one tap" smooth (iOS Action Button, a Flitdrop keyboard). It never turns "one tap" into "zero tap" on iPhone: reading the clipboard in the background is an Apple lock nobody bypasses, and the 2025-2026 trend is toward more restrictions, not fewer.

Honest positioning: **"your clipboard everywhere, in one gesture,"** not "by magic." (Version française détaillée : [presse-papiers.md](presse-papiers.md).)
