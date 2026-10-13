# Domain ownership and dependency map

**Purpose:** Record the prototype's initial ownership and source enforcement authority.
**Audience:** Implementers and architecture reviewers.
**Status:** Planned product owners; active quality tooling.
**Authority:** The accepted prototype specification and jev source organization policy.
**Expected use:** Name the owner and public seam before introducing product source.
**Lifecycle:** Update the manifest and this map together when owners or dependency directions change.

## Authority

`quality-owners.json` is the executable dependency declaration for backend product source. A missing owner root is planned, not an implemented capability. Once a root exists it must have its declared public entrypoint. There is no product source yet.

Each entrypoint hides sequencing, state coordination and implementation files. Cross-owner callers may import only the declared entrypoint; local implementation imports remain local. A dependency permission is an upper bound, not an instruction to create an interface or import it prematurely. Keep types with the concept they describe.

| Owner              | Policy and state it owns                                                                                 | Permitted domain dependencies                      |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Conversation       | Sole conversation, input acceptance, response identity, interruption and recovery                        | Memory, answer generation                          |
| Memory             | Hosting real unii, durable adapter, bounded reads, summary readiness and independent compaction lifetime | Summary generation                                 |
| Answer generation  | Parsed reply requests and typed streaming/cancellation outcomes; fake reply implementation               | None                                               |
| Summary generation | Parsed summary requests and typed completion/cancellation outcomes; fake summary implementation          | None                                               |
| Speech recognition | Bounded audio recognition and validated partial/final outcomes; fake recognition implementation          | None                                               |
| Speech synthesis   | Phrase-input synthesis and validated audio/terminal outcomes; fake synthesis implementation              | None                                               |
| Voice              | Temporary voice-session delivery, transport and stale-media rejection                                    | Conversation, speech recognition, speech synthesis |
| Bootstrap          | Configuration parsing and resource acquisition/release, assembling Layers and adapters                   | The owners above                                   |

There is no separate framework memory or competing conversation state. unii stays plain TypeScript with injected storage/backend ports. Balabol's memory host owns Effect integration; interruption and phone disconnection cannot close that host. Bootstrap does not decide conversation policy.

## Vertical slices and clients

A delivery ticket follows a capability across its backend owner, validated wire contract, Swift projection and behavioral verification. Technical subfolders may exist inside a capability; global `models`, `services`, `types` and `utils` owners do not.

The Swift client has local conversation and voice-session capability slices plus a small application composition root. SwiftUI Views and MainActor ViewModels live inside those slices. They translate intents and project observable backend state; they do not become a second authority for acceptance, durability, compaction or response identity. Client transport adapters belong to the capability they serve. No Swift interfaces or folders are prebuilt in this preparatory ticket.

The conversation application boundary is the approved primary behavioral seam, composed later with real unii, real durable storage and deterministic fake Layers. Contract tests use public adapter interfaces. Client ViewModel tests cover projections and intents; physical audio evidence remains a separate platform qualification.

## Enforcement and review

The architecture CLI parses TypeScript syntax rather than matching text. It resolves compiler aliases and local imports, exports, type queries and literal dynamic imports, follows the complete resolved local source closure and rejects file cycles and declared owner cycles. It rejects undeclared owners/packages, cross-owner private entrypoints, invalid manifests, computed imports and unresolved targets. It checks canonical paths so symlink escapes do not silently grant access. dpdm adds independent runtime import-cycle evidence.

This checks declared static source dependencies, not arbitrary runtime reflection, generated bundles or Swift source. Those require their own artifact/platform checks when introduced. Swift strict concurrency, ownership review and behavioral/UI checks remain mandatory in client tickets; no absent client is reported as validated.

Substantial owner/interface or composition changes require architectural agent review in addition to green checks. Planned roots must be updated deliberately when concrete implementation justifies a different boundary; do not create forwarding modules merely to match this map.
