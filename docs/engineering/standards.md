# Engineering standards

**Purpose:** Preserve the mandatory architecture and TS quality baseline for the prototype.
**Audience:** Contributors and reviewers, including coding agents.
**Status:** Active.
**Authority:** Owner-mandated reuse of jev architecture and hulymcp TypeScript rules.
**Expected use:** Apply during design, implementation and review; complete the tooling gate before accepting product implementation.
**Lifecycle:** Review on dependency, owner/interface, enforcement or validation changes.

## Architecture

Source authority: sibling jev's source organization policy, accepted 2026-10-10. Before structural work consult that policy when the checkout is available. The following portable rules are mandatory here:

- Name the domain owner before folders/packages. Keep local types and behavior with that owner.
- Each vertical capability slice includes entry, workflow, domain models, effects and behavioral tests. Technical layers may exist within a slice, not as repository-wide buckets.
- Shared owners require a named concept, concrete consumers and dependency direction; avoid omnibus common/types/utils folders.
- One authority owns each policy and lifecycle state. Swift ViewModels project state and translate intents rather than becoming a second conversation authority.
- Narrow public interfaces hide internal sequencing and coordination; document invariants, errors and resource lifetime.
- Composition roots acquire/release resources and assemble adapters. They do not own domain policy.
- Source dependencies are acyclic, including type-only, lazy and transitive imports. Type-only cycle enforcement must supplement tools that ignore those edges.
- Extract packages for real consumption/build/enforcement needs, not one package per folder.
- Substantial ownership/interface changes require architectural agent review; tests do not replace it.

## TypeScript / Effect

Source authority: sibling hulymcp CLAUDE.md, review rules and its Effect reference policy. Port generic rules, not Huly/MCP product semantics:

- Effect Schema owns I/O contracts and derives types. Parse unknown input once at the edge and pass parsed domain values onward; encode outputs through schemas.
- Expected failures remain typed Effect errors. Deterministic core decisions are separate from protocol/SDK/I/O code.
- Dependencies, time and configuration are explicit. Parse config at startup; wrap secrets in Redacted and reveal only in the adapter that needs them.
- No import-time resource acquisition or scattered environment reads. Scoped Layers own lifetimes; no nested ad hoc runtimes.
- Meaningful domain types and units; discriminated states exclude impossible combinations. Prefer immutable values and avoid type assertions.
- Tests substitute concrete implementations via Layers/ports, never module monkey-patching or spy/mock APIs. Fake providers implement the real interface and deterministic test clock.
- Use installed declarations and pinned sources for the exact Effect cohort. Select and pin a mutually compatible cohort; do not copy the Huly-specific patch.

## Complete TS harness required before product acceptance

| Gate                     | Required baseline                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Package manager/compiler | pnpm, TS7 native strict checks; exact optional properties, unchecked indexes, unused locals, overrides and switch fallthrough    |
| Effect                   | exact compatible cohort; @effect/vitest; @effect/tsgo error and warning diagnostics                                              |
| Behavior/coverage        | Vitest v8; 99% lines, functions, branches and statements; no module mocks                                                        |
| Properties               | fast-check tests in \*.property.test.ts; enforced placement                                                                      |
| Duplication              | jscpd maximum 2%                                                                                                                 |
| Cycles                   | dpdm plus enforcement of type-only architecture edges                                                                            |
| Complexity               | Oxlint classic maximum 8 for production TS                                                                                       |
| Lint/format              | type-aware Oxlint, generic project lint rules, dprint Oxc for TS, maximum 420 nonblank/noncomment lines; split by responsibility |
| Commit safety            | Husky, lint-staged, gitleaks; secret scan before formatting/type/test work                                                       |
| Full gate                | build, compiler, Effect diagnostics, cycles, complexity, lint/duplication and tests/coverage                                     |

Current hooks and package are repository scaffolding: Husky/lint-staged format Markdown/JSON/YAML using Prettier and run gitleaks. Product TS tooling above must be installed and wired when source is introduced; the pre-commit hook requires typecheck/test if the source directory exists. Empty-source results must never be reported as product validation. Swift needs strict concurrency, behavioral ViewModel tests, XCTest/UI checks and physical audio evidence; TS numeric tooling thresholds are not mechanically imposed on Swift.

## Evidence

Highest useful behavioral interface is the sole conversation application interface, composed with the real unii core and durable storage and fake providers. Adapter contract tests verify parsing, streaming, terminal outcomes and cancellation; Swift tests cover projected state/intents and platform integration. Source/documentation-backed interface validation is distinct from actual inference latency, voice quality and locked-screen reliability.
