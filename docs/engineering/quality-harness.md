# Quality harness

**Purpose:** Describe the mandatory gate and its executable self-check evidence.
**Audience:** Contributors and reviewers.
**Status:** Active tooling; product validation pending until source exists.
**Authority:** Prototype specification and inherited hulymcp generic quality rules.
**Expected use:** Run focused gates while changing code and `pnpm check-all` on a coherent final candidate.
**Lifecycle:** Review with dependency, ownership or enforcement changes.

## Commands and contracts

`pnpm check-all` scans files for secrets before running tooling self-checks, then checks cohort, build, compiler, Effect diagnostics, architecture, dpdm cycles, complexity, lint, duplication, format and behavior/CRAP. Markdown, JSON, YAML and tooling JavaScript use Prettier; TypeScript uses the pinned dprint Oxc plugin exclusively. Both format checks are required. When the LiveKit adapter exists, the behavior gate starts a pinned, isolated LiveKit Docker fixture automatically, passes its private configuration only to the test process, and removes the container and temporary keys after the run. Docker is required for this transport gate; synthetic RTC frames verify the adapter and do not replace microphone or physical-device qualification.

The public `node scripts/quality/cli.mjs <gate> [--root <directory>]` interface supports isolated temporary fixture roots. Gates are `cohort`, `build`, `compiler`, `effect`, `architecture`, `cycles`, `complexity`, `lint`, `duplication`, `format`, `behavior`, `crap`, `secrets` and `all`. Unknown gates and subprocess failures/timeouts fail closed. Compiler configuration remains checked even without product source. Product-specific gates explicitly report the absence of source; that is harness readiness, never application acceptance.

`pnpm test:harness` drives that CLI with temporary positive/negative fixtures, without installing models or introducing a dummy production domain. It checks compiler rejection, Effect diagnostics, mock/monkey-patch bans, clock/cast/schema rules, property placement, line count, runtime/type-only/lazy/alias/private-owner dependencies, duplication, CRAP risk and actual secret hooks. Test fixtures are removed even on failure. Tooling subprocesses are bounded; fixtures do not alter this repository's Git index or history.

The tooling CLI is a Node bootstrap shell with focused filesystem/process adapters and source-analysis modules. Its JavaScript is format checked and its behavior is tested at the executable boundary. The inherited TS compiler, numeric complexity and product CRAP gates govern production TypeScript, not this Node tooling shell. No blanket product coverage exclusions are added.

## Required limits

- TS7 strictness includes exact optional properties, unchecked indexes, unused locals/parameters, overrides and switch fallthrough. Typechecking checks all TS source, tests and configs; build emits production source separately.
- Effect error and warning diagnostics run with strict severity and native tool exit status preserved.
- Type-aware Oxlint includes generic hulymcp project rules, with Huly-specific schema primitives and SDK imports removed. Imported-module and global monkey-patching, aliased mock APIs and fake clocks are rejected. Tests substitute explicit ports/Layers.
- Property imports and property calls belong in `*.property.test.ts`; 420 nonblank/noncomment lines applies to TS files, including tests. Property calls are qualified by provider provenance, including direct, named, namespace and nested Effect layer callbacks. In ordinary test files, Layer registrations use inline callbacks with simple named or literal destructured runner bindings. Callback references, computed bindings, rest/default bindings and other ambiguous forms fail closed rather than silently losing provenance. Correctly named property files remain exempt; ordinary inline Layer DI tests and unrelated methods remain allowed.
- Production classic complexity is at most 8, with no baseline; jscpd duplication is at most 2%.
- Vitest v8 produces fresh Istanbul JSON for `@crap4ts/crap4ts` **1.1.0**, which enforces a maximum per-function CRAP score of **8** (default statement coverage metric). Aggregate coverage percentages are informational and have no threshold. Missing or ambiguous coverage fails; report-only mode is explicitly disabled. The behavior gate deletes the previous artifact before testing, then runs CRAP; the standalone `crap` gate checks an existing artifact and is a diagnostic command, not a freshness guarantee. Untested production files are included; tests and declaration-only files are excluded. Product source without behavioral tests fails.
- Husky pre-commit scans staged secrets before lint-staged formatting, compiler/Effect diagnostics and behavior tests. Pre-push scans history. gitleaks uses its default rules, redacts output and ignores allow-comments.

CRAP combines complexity and measured coverage: `complexity² × (1 − coverage)³ + complexity`. Simple partially covered functions can pass; risky insufficiently covered functions fail. The independent classic complexity cap remains 8. Use Node >=22.19 and <25: the published crap4ts package excludes Node 25; this harness was verified with the isolated Node 24.14.0 runtime, without adding a machine-specific executable path.

## Exact Effect evidence

The unpatched cohort is `effect`, `@effect/platform-node`, `@effect/platform-node-shared` and `@effect/vitest` at **4.0.5**, `@effect/tsgo` at **0.36.4**, and Vitest/v8 at **5.0.1**. TS7 is `@typescript/native` aliased to **typescript 7.0.2**; the source checker separately uses TypeScript 5.9.3's JavaScript compiler API. All direct tooling dependencies are exact pins in the lockfile.

The Yielded compatibility task upgraded the complete Effect cohort to 4.0.5 and added `@yielded/agent` 0.1.0-beta.185, whose Effect peer requires at least 4.0.3. The explicit node-shared override holds its resolved version at 4.0.5; `pnpm install --strict-peer-dependencies` succeeds. `verify:effect-cohort` checks exact declared/installed versions, recursively checks the installed dependency tree, rejects obsolete Effect packages or patches and verifies native tsgo startup. Huly's product-specific Effect patch is absent.

Reference order: exact installed package declarations and `node_modules/effect/AGENTS.md`, then the upstream Effect tag `effect@4.0.5`. The existing Schema, service and Layer usage remains typechecked with zero Effect diagnostics. Yielded smoke checks use an injected native Effect AI model and an explicit tool; they do not qualify subscription inference or production agent integration. No moving source checkout is required by routine checks.

The owner/dependency authority is documented in [ownership](ownership.md). No test with fake providers qualifies real model access, inference speed, language quality or physical background audio.
