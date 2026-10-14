# Domain ownership and dependency map

**Purpose:** Record the prototype's initial ownership and source enforcement authority.
**Audience:** Implementers and architecture reviewers.
**Status:** Planned product owners; active quality tooling.
**Authority:** The accepted prototype specification and jev source organization policy.
**Expected use:** Name the owner and public seam before introducing product source.
**Lifecycle:** Update the manifest and this map together when owners or dependency directions change.

## Authority

`quality-owners.json` is the executable dependency declaration for backend product source. A missing owner root is planned, not an implemented capability. Once a root exists it must have its declared public entrypoint. Conversation, Memory, answer generation, summary generation and Bootstrap implement the durable text slice. Voice and speech recognition implement microphone delivery and supplied-audio recognition. Speech synthesis accepts a complete bounded phrase and emits validated fixture audio; it does not accept appended text or install an inference engine.

Each entrypoint hides sequencing, state coordination and implementation files. Cross-owner callers may import only the declared entrypoint; local implementation imports remain local. A dependency permission is an upper bound, not an instruction to create an interface or import it prematurely. Keep types with the concept they describe.

| Owner              | Policy and state it owns                                                                                             | Permitted domain dependencies                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Language           | Canonical BCP47 tags and validated UTF-16 text spans shared by language-aware contracts                              | None                                                         |
| Conversation       | Sole conversation, input acceptance, response identity, interruption and recovery                                    | Memory, answer generation, Language                          |
| Memory             | Hosting real unii, durable adapter, bounded reads, summary readiness and independent compaction lifetime             | Summary generation, Language                                 |
| Answer generation  | Parsed reply requests and typed streaming/cancellation outcomes; fake reply implementation                           | Language                                                     |
| Summary generation | Parsed summary requests and typed completion/cancellation outcomes; fake summary implementation                      | None                                                         |
| Speech recognition | Bounded audio recognition and validated partial/final outcomes; fake recognition implementation                      | Language                                                     |
| Speech synthesis   | Phrase-input synthesis and validated audio/terminal outcomes; fake synthesis implementation                          | Language                                                     |
| Voice              | Temporary voice-session delivery, transport and stale-media rejection                                                | Conversation, speech recognition, speech synthesis, Language |
| Subscription       | Backend-only ChatGPT authorization, protected credentials, refresh and model catalog; no conversation or agent state | None                                                         |
| Bootstrap          | Configuration parsing and resource acquisition/release, assembling Layers and adapters                               | The owners above, Subscription                               |

Language is a shared value-contract owner consumed by Conversation, Memory, answer generation, speech recognition, speech synthesis, Voice and Bootstrap. It validates canonical tags and text-span boundaries; it does not select response languages or providers. Conversation owns response-language preference from accepted annotations. Voice owns allowed-language configuration and validates it against the selected providers. Provider capabilities are explicit; canonical tags do not imply installed support.

There is no separate framework memory or competing conversation state. unii stays plain TypeScript with injected storage/backend ports. Balabol's memory host owns Effect integration; interruption and phone disconnection cannot close that host. Bootstrap does not decide conversation policy.

## Vertical slices and clients

A delivery ticket follows a capability across its backend owner, validated wire contract, Swift projection and behavioral verification. Technical subfolders may exist inside a capability; global `models`, `services`, `types` and `utils` owners do not.

The Swift client has local conversation and voice-session capability slices plus a small application composition root. SwiftUI Views and MainActor ViewModels live inside those slices. They translate intents and project observable backend state; they do not become a second authority for acceptance, durability, compaction or response identity. Client transport adapters belong to the capability they serve. Both slices have concrete state, events and owned asynchronous tasks. The LiveKit adapter owns microphone capture through the SDK's single audio-session owner.

The conversation application boundary is the approved primary behavioral seam, composed with real unii, real durable storage and deterministic fake Layers. Contract tests use public adapter interfaces. Client ViewModel tests cover projections and intents; physical audio evidence remains a separate platform qualification.

### Native client state and the TCA adoption condition

Start new client behavior in its capability's state, event and transition definitions. The transition owns decisions; the MainActor ViewModel projects state and interprets concrete commands through injected adapters. Keep independently concurrent lifecycles and failures separate. Async results carry operation identities; cancellation and stale-result rejection are distinct responsibilities. Backend receipts/history own accepted conversation facts, while the client owns draft delivery and observation progress. A merged receipt must not advance the history cursor past unloaded records.

Keep this pattern discoverable in capability-local source names and short invariant comments. Do not build a generic Store, middleware, task router, effect algebra or test runtime.

Consider [TCA](https://github.com/pointfreeco/swift-composable-architecture) only when a concrete capability being delivered requires shared effect orchestration, nested feature lifetimes or composed async-effect testing that the concrete capability pattern cannot reasonably satisfy without building such generic infrastructure. Record the concrete scenario and why feature-local state and owned tasks are insufficient before adopting it. More screens, hypothetical voice complexity or a preference for Redux syntax alone do not trigger adoption. If TCA is selected, revise the MVVM decision explicitly and use its Store as the presentation authority; do not mirror Store state in another ViewModel. Backend acceptance and unii memory authority remain unchanged.

## Enforcement and review

The architecture CLI parses TypeScript syntax rather than matching text. It resolves compiler aliases and local imports, exports, type queries and literal dynamic imports, follows the complete resolved local source closure and rejects file cycles and declared owner cycles. It rejects undeclared owners/packages, cross-owner private entrypoints, invalid manifests, computed imports and unresolved targets. It checks canonical paths so symlink escapes do not silently grant access. dpdm adds independent runtime import-cycle evidence.

This checks declared static source dependencies, not arbitrary runtime reflection, generated bundles or Swift source. Those require their own artifact/platform checks when introduced. Swift strict concurrency, ownership review and behavioral/UI checks remain mandatory in client tickets; no absent client is reported as validated.

Substantial owner/interface or composition changes require architectural agent review in addition to green checks. Planned roots must be updated deliberately when concrete implementation justifies a different boundary; do not create forwarding modules merely to match this map.

## Durable text slice

Conversation owns validated send/page wire contracts, conflict admission and serialized delivery. Memory owns schema-parsed durable delivery evidence and receipts, raw batches, SQLite transactions, checkpoints and the unii lifecycle. The public `DurableMemory` port supports real storage composition and fault decorators through Layers; its prepare/raw-append protocol is internal to the memory host's serialized admission. Bootstrap composes the concrete SQLite memory and HTTP server Layers. The backend defaults to loopback; explicit private-network binding is startup configuration.

`SqliteMemoryStorage` is a composition-only resource, acquired once through `sqliteStorageLayer`. Bootstrap shares its held database and exclusive writer lease with the Memory adapter and Voice's speech-admission adapter. Voice owns its admission table, migrations and bounded recovery operations; it borrows the database and never closes it. Domain services do not receive SQL handles. Both consumers finish scoped work before the shared resource closes; standalone `sqliteLayer` retains the same acquisition and lifetime guarantees.

Acceptance commits the complete raw batch and delivery association atomically. Post-raw tree persistence failure leaves the durable receipt available for retry. Memory serializes core append/recovery/shutdown and automatically closes and reconstructs a failed unii session on the next admitted send. The underlying durable adapter and exclusive lease remain acquired across session recovery. Persistent failure is bounded to one recovery attempt per send and remains a typed error; a later send resumes once the store recovers. Acknowledgement is durable input acceptance, independent of summary readiness. Bounded history queries do not imply bounded unii startup hydration. Tests exercise the real conversation seam and temporary SQLite database, socket transport, injected persistence failure and actual process termination.

## Subscription connection

Subscription owns its OAuth attempt, validated account connection, protected credential persistence and serialized refresh. Bootstrap mounts a separate loopback-only setup console; it is never included in phone or Tailscale control routes. Answer and summary adapters may later consume its narrow authenticated capability, while Conversation and unii remain independent of OAuth. A scoped writer lease prevents concurrent local processes from rotating or deleting the same credential store.
