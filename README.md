# Balabol

**Purpose:** Describe the repository and its current development state.
**Status:** Specification and repository scaffold; the app is not implemented.
**Authority:** Product requirements live in the published prototype issue; engineering guidance lives in AGENTS.md.
**Expected use:** Start here before contributing.
**Lifecycle:** Update when the product spec, setup or implementation status changes.

An iOS-first personal voice assistant with one enduring conversation. SwiftUI/MVVM client, TypeScript/Effect backend, @firfi/unii memory. Initial speech, answer and summary providers are deterministic fakes; local speech and subscription model integration are deferred.

- [Accepted prototype specification](https://github.com/dearlordylord/balabol/issues/1) — ready-for-agent
- [Synchronized local specification](docs/product/prototype-spec.md)
- [Domain glossary](GLOSSARY.md)
- [Wayfinder map](.scratch/voice-prototype/map.md)
- [Engineering standards](docs/engineering/standards.md)
- [Deferred real-model qualification](.scratch/followups/issues/01-create-real-model-check-task.md)

## Repository tooling

Use Node 22.19+ and the pinned pnpm. Install gitleaks separately (macOS: brew install gitleaks), then run pnpm install to activate Husky.

Run pnpm check:repository for formatting and staged-secret checks; pnpm secrets:files scans the working tree and pnpm secrets:history scans Git history. Pre-commit scans staged content before formatting. Pre-push scans history. Missing gitleaks fails the hooks.

These checks validate repository scaffolding. Product compiler/test/coverage gates are required as product code is added; no empty test suite is presented as passing product acceptance. Speech engines and model weights are not installed by repository setup.
