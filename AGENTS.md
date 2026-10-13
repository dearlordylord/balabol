# Balabol contributor instructions

**Purpose:** Route contributors to product authority and mandatory engineering rules.
**Audience:** Contributors, including coding agents.
**Status:** Active.
**Authority:** Maintained guidance derived from owner instructions.
**Expected use:** Apply before changing product code, contracts, tooling or documentation.
**Lifecycle:** Review when scope, state ownership, testing or delivery policy changes.

- Write repository documentation, specifications, issue titles/bodies, comments and commit messages in English. User-facing conversation may use the user's language.
- Before implementation, read the published prototype issue identified in README; use the [glossary](GLOSSARY.md).
- Before designing or changing owners, imports or interfaces, read [engineering standards](docs/engineering/standards.md). Domain owners and vertical slices apply to Swift and TS; MVVM lives inside Swift slices.
- Before TS implementation, port the complete hulymcp quality harness described in the standards. The current repository hooks cover scaffolding only; they do not prove product checks pass.
- Keep unii plain TypeScript memory logic with injected storage/backend ports. Balabol owns Effect integration; necessary changes in sibling unii are authorized.
- Use deterministic fake providers through Effect Layers for this prototype. Ground adapter interfaces in inspected contracts and validate boundary data; exercise cancellation, late events and errors. Model installs, downloads and actual inference are deferred to the follow-up task.
- UX recommendations go to Astra by owner instruction. Ask the owner domain/scope/cost questions, not routine UX choices. An explicit Astra model override must use a fresh context fork.
- Before issue operations, read [tracker guidance](docs/agents/issue-tracker.md). Research is advisory; the product issue owns requirements.
- Keep credentials, private conversation data, downloaded models and local recordings out of Git. Commit/push hooks scan for secrets and must pass.
