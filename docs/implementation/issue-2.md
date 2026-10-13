# Establish the complete quality harness: candidate evidence

**Purpose:** Record implementation and verification of the first preparatory slice.
**Audience:** Owner, orchestration agent and independent reviewers.
**Status:** Implemented candidate; independent review and owner acceptance pending.
**Authority:** [Establish the complete quality harness](https://github.com/dearlordylord/balabol/issues/2) and the accepted prototype specification.
**Expected use:** Review against baseline `9892ef0645031fca10e7d05553c731a51f37aeb7`; do not infer product readiness from this receipt.
**Lifecycle:** Append material review corrections and their evidence before acceptance.

## Acceptance evidence

| Ticket criterion                                         | Implemented result and evidence                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact compatible Effect cohort                           | Unpatched 4.0.0 core/platform-node/node-shared/vitest, tsgo 0.36.4 and Vitest/v8 5.0.1; direct exact pins, recursive installed-tree/version checks, native tsgo startup and strict peers pass. The explicit node-shared override resolves the observed 4.0.4 peer drift.                                                                                                             |
| TS7, Effect diagnostics, tests and properties            | Native TypeScript 7.0.2 strict settings, error/warning diagnostics, @effect/vitest, v8 99% in all four metrics, fast-check and enforced property-file placement. A temporary integration fixture actually typechecks and runs native Schema properties and independent fast-check properties with deterministic seeds.                                                               |
| Duplication, complexity, lint, formatting and line count | jscpd maximum 2%, production classic complexity maximum 8, type-aware Oxlint and generic project rules, dprint Oxc 0.32.0, 420 nonblank/noncomment TS lines. Positive boundary fixtures accept complexity 8 and 420 lines; corresponding negatives are rejected.                                                                                                                     |
| Dependency and ownership enforcement                     | Syntax/resolver-based complete local source closure, type-only/import-type/lazy/static/export edges, aliases, private/public owner entrypoints, declared owner cycles and file cycles. Unknown owners/packages, malformed configuration/source, symlink escapes, computed dependencies and aliased loader factories fail closed. Independent dpdm runtime-cycle fixture is rejected. |
| Full gate                                                | check-all sequences secrets before self-checks, cohort, build, compiler, Effect diagnostics, architecture, dpdm, complexity, lint, duplication, formatting and behavior/coverage. All configured stages passed on the final candidate.                                                                                                                                               |
| Meaningful temporary fixtures                            | 45 public CLI/hook checks passed. They include invalid types, discarded Effects, casts/clocks/aliased mocks/spies/monkey-patches, property placement, private/aliased/type-only/lazy/transitive cycles, duplication and uncovered branches. Disabling cycle detection made the corresponding test fail; restoring it passed. Fixtures are temporary, not production code.            |
| Hooks and truthful absence of product                    | Actual synthetic safe commit passes; secret-bearing commit is rejected before formatting/typechecking; a synthetic unsafe history fails the actual pre-push script. gitleaks defaults/redaction/no allow-comments are preserved. Product-only gates explicitly report no source and no product acceptance.                                                                           |
| Initial owner map and seams                              | Planned conversation, memory, independent provider roles, voice and bootstrap dependencies are recorded in the executable manifest and ownership policy. Swift capability/MVVM boundaries and the approved conversation seam are documented without prebuilding speculative app interfaces.                                                                                          |

## Verification

- `pnpm install --frozen-lockfile --strict-peer-dependencies`: passed with no resolution/lock changes.
- `pnpm check-all`: passed; **45/45** tooling tests; Effect diagnostics **0 errors, 0 warnings** for the current TS configuration.
- Focused compiler, Effect, lint, property-runtime, architecture, coverage, duplication and actual-hook checks passed during implementation.
- Initial RED: the public CLI type-only-cycle test failed before the checker existed. Mutation check: removing explicit file-cycle detection failed the same CLI test, then passed after restoration.
- One intermediate whole-gate run exposed a symlinked tooling fixture incompatible with the new source-symlink policy. The fixture now copies tooling; the production policy was preserved. A declaration audit then corrected an initially lint-only property fixture: Effect v4 `it.prop` accepts native Arbitrary/Schema, not fast-check's arbitrary. The final fixture executes both supported APIs instead of claiming compatibility from syntax alone.
- The upstream Effect reference commit was verified in the sibling pinned checkout; actual installed Schema, Context, Layer and @effect/vitest declarations were inspected. No Huly patch or product-specific API was copied.

## Limits and handoff

There is no application source, durable memory implementation, backend server or Swift client yet. Build/runtime cycles/complexity/duplication/product coverage are demonstrated against temporary fixtures; their empty-project result is **not product acceptance**. Node tooling JavaScript is format checked and tested through the public executable seam; the inherited numeric production gates apply to production TS. Static source checks do not prove arbitrary runtime reflection, generated-artifact isolation or Swift/platform behavior.

No changes to unii, model installation/download, actual inference or physical audio qualification occurred. The issue remains open for independent Standards/Spec review and owner discussion; this ticket does not authorize starting the next slice.

## Review loop: round 1

Independent Standards/Spec review found four enforcement gaps: property placement was scoped only to test files, extracting mock API members bypassed the call visitor, aliases of imported/global objects bypassed the mutation guard, and type-only import-equals module references were absent from the architecture graph.

Six public CLI regression fixtures first reproduced these gaps as RED: the forbidden inputs incorrectly exited successfully. Corrections enable property placement globally (only `*.property.test.ts` is exempt), reject forbidden test-API member extraction, propagate imported/global origins through direct aliases, and resolve import-equals external module references through the existing owner/private-entrypoint/cycle checks. The mutation guard remains specific to imported/global origins; it does not prohibit ordinary local object mutation. Positive fixtures preserve that behavior and permit an import-equals dependency through its declared public entrypoint.

Focused round-1 verification passed **8/8** fixtures. The coherent `pnpm check-all` candidate then passed **53/53** checks, every configured gate and Effect diagnostics with **0 errors, 0 warnings**. Numeric thresholds, secret-first hooks, absence-of-source reporting and product scope remain unchanged. Independent re-review and owner acceptance remain pending.

## Review loop: round 2

Spec re-review passed. Standards re-review identified a regression introduced by globally enabling property placement: the call visitor matched method spelling alone, so an ordinary local `prop`, `property` or `asyncProperty` method was rejected despite having no property-test provider.

The ordinary-method fixture reproduced that regression as RED. The rule now recognizes imported fast-check and @effect/vitest bindings, their supported property runner members, direct aliases and destructuring. It does not infer property testing from an unrelated method's name. The existing fast-check import restriction remains global, with only correctly named property files exempt. New negative fixtures cover aliased, destructured, namespace and directly imported Effect property runners outside property files; the positive ordinary-method fixture passes.

Focused placement/runtime integration verification passed **8/8** checks. The coherent `pnpm check-all` candidate passed **58/58** checks, every configured gate and Effect diagnostics with **0 errors, 0 warnings**. Independent re-review and owner acceptance remain pending; no next-ticket implementation has started.
