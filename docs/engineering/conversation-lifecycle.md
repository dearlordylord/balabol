# Conversation lifecycle protocol

**Purpose:** Define lifecycle authority, ordering and execution contracts for the functional conversation migration.
**Audience:** Implementers and architectural reviewers.
**Status:** Accepted target protocol; #52 qualifies the boundary, #53–#58 migrate product behavior.
**Authority:** [Specification #51](https://github.com/dearlordylord/balabol/issues/51), its child issues and owner-delegated Astra review.
**Expected use:** Start Conversation or Voice state changes here, then follow the owner-local transition and interpreter.
**Lifecycle:** Update this protocol with changes to ownership, command acknowledgement or cancellation semantics. Do not describe planned guarantees as implemented.

## Authority and decomposition

Conversation owns pending input operations, response eligibility, the active response attempt, delivery authorization and its exact terminal persistence intent. Memory owns durable receipts and retained context through unii. A lifecycle snapshot is not a second durable transcript.

Each VoiceSession owns capture, provisional spoken-turn assembly and session-specific output. The voice registry owns start reservations and bounded retained-session identity. Segmentation, recognition assembly and output are named subtransitions within VoiceSession, not independent schedulers merely because they have separate source modules.

Conversation and VoiceSession stay separate because text operation and handed durable admission outlive media capture. Memory compaction is independent of response and media cancellation. Swift owns client intent, checkpoints, local platform availability and projections of server facts; it cannot decide durable acceptance.

| Fact                                           | Sole decision authority                                                 | Other representations                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Durable acceptance and message order           | Memory receipt/transaction                                              | Conversation operation result; client transcript/checkpoint |
| Pending input intent and response eligibility  | Conversation                                                            | Voice admission tracking; client pending projection         |
| Response outcome and delivery ticket           | Conversation                                                            | Voice output projection; client response projection         |
| Capture generation and provisional spoken turn | VoiceSession                                                            | Recognition commands/results; native capture projection     |
| Permission to publish on a media output        | VoiceSession output decision, constrained by Conversation authorization | Synchronously revocable resource gate                       |
| Physical resources and work handles            | Scoped interpreter/adapter                                              | Domain operation IDs and release obligations, never handles |

## Pure transition and interpreter contract

A transition accepts immutable state and an event and returns new immutable state plus command data. Events carry validated facts, including time and generated identities. Commands contain no callbacks, services, fibers, mutable buffers or closures. Explicit deterministic counters may generate internal identities when their uniqueness scope is sufficient.

Every public request, provider callback, deadline and completion enters the appropriate owner. The owner's processed event order is its linearization order. Only this owner replaces its state; a short atomic state update does not grant arbitrary callers permission to execute returned commands concurrently out of order.

The transition reserves capacity and records a command obligation before dispatch. The interpreter starts I/O outside the transition loop and reports a correlated completion. Public callers may await a result deferred outside the loop. Slow storage, provider execution, cleanup or another owner's acknowledgement must not monopolize the loop or prevent processing a fence.

Each obligation has a stable operation ID. It remains pending until matching success, an explicit definitive rejection or a specified recovery state. Dispatch alone is not acknowledgement. A retry preserves the obligation identity and immutable payload; a stale or duplicate acknowledgement cannot settle another obligation. Transport retries are not exactly-once external execution. Retrying a speech fence returns its original applied revision; it must not advance the revision again and revoke newer work.

Capacity counts reserved and executing work. A full queue cannot discard admission, fence or release obligations: reserve capacity, apply backpressure or enter an explicit failure state. Neither owner waits inside its transition loop for another owner that is waiting for it.

Expected failures are typed facts. They cannot silently remove an unresolved obligation or imply a successful resource release. Unexpected defects remain distinguishable from expected provider/storage failure. Existing user-facing retry and failure semantics remain authoritative.

## Identity and immutable payload mapping

Use the existing wire identities at the transport edge. Internal compact tokens may represent them in the Bend core only through a lifetime-scoped, collision-free mapping whose correspondence is tested at the real bridge.

| Identity                         | Meaning and required scope                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Backend incarnation              | Distinguishes host restart/recovery evidence                                                       |
| Start request                    | Makes voice start idempotent without equating different initial intent                             |
| Session and capture generation   | Fence media, classification and recognition from old lifetimes/tracks                              |
| Input delivery                   | Stable input payload and durable acceptance identity                                               |
| Input intent revision            | Orders pending input eligibility and processed speech fences inside Conversation                   |
| Response attempt                 | Distinguishes explicit retry from revival of a terminal response                                   |
| Delivery registration and ticket | Bind settlement to the authorized response consumer and delivery attempt                           |
| Output epoch                     | Distinguishes a concrete publication/readiness lifetime                                            |
| Operation                        | Correlates one outstanding command obligation and acknowledgement                                  |
| Fragment/payload token           | Refers to adapter-owned immutable content without embedding writable PCM/resources in domain state |

A token conservation proof does not prove the bytes it denotes. The interpreter must prevent token reuse while late events remain possible, preserve the original immutable payload mapping and release content only after the owning obligation permits it. A payload must not be a reference into an externally reused writable buffer.

## Admission, supersession and response start

1. Conversation registers the input intent and reserves its operation identity before asynchronous durable admission. Voice retains its association for recovery; it does not become another eligibility writer.
2. The interpreter submits the exact payload to Memory. Accepted input is established by a matching durable receipt, not by a recognition final or publication of a pending event.
3. New speech immediately revokes the local resource publication gate and sends a correlated speech-fence command to Conversation. Existing native local suppression remains independent of network round trips.
4. Conversation processes the fence in its event order, revokes affected older pending intents and invalidates the applicable response authorization. Its acknowledgement identifies the applied revision.
5. An eligible matching acceptance creates one logical response-start obligation once prerequisite terminal persistence is settled. A superseded matching acceptance still retains and acknowledges the input, but cannot create that start obligation.
6. The interpreter delivers facts to Voice/client projections. Delayed delivery cannot grant permission absent from the current authorization.

There is no atomic instant spanning the Voice and Conversation loops. Conversation-side revocation is guaranteed from its processed fence, identified by acknowledgement. Immediate resource suppression protects local output while that command is in transit. Start/publication handshakes must carry the relevant revision and exact target rather than assuming an earlier physical speech onset was already observed by Conversation.

The authorization check must hold at the actual publication boundary, including after asynchronous synthesis or readiness waits. Checking only when a command is dequeued permits a stale capture to publish later. The resource gate is synchronously revocable; its private implementation does not make independent domain policy.

## Completion and interruption

Cancellation first records logical invalidation and revokes resource authorization, then requests physical cancellation. A delayed or noncooperative worker may finish, but its old generation/operation/response cannot change the selected state or release stale audio.

Conversation selects completion versus interruption in its own event order. Once the terminal persistence intent is selected, it retains the exact outcome and immutable payload identity through storage failure and retry. A successful matching receipt establishes the durable terminal result. An explicit retry under existing product rules is a distinct response attempt.

Generated text, durable terminal text and delivered audio remain different evidence. Saved interrupted text may contain words not heard by the owner. Neither recognition nor output state may manufacture durable receipts or word-level heard attribution.

## Lifetime and closure

| Lifetime         | Owns                                                                                          | What closure must preserve                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Host             | Conversation execution, Memory writer and independent summaries, handed admission/recovery    | Exact unresolved durable obligations until settlement or honest recovery evidence |
| VoiceSession     | Media connection, capture/classification/recognition/output workers and publication resources | Host-owned admission; durable input and history                                   |
| Response attempt | Answer work and its delivery authorization/deadline                                           | Memory summaries and already accepted input                                       |
| Client feature   | Tasks, draft/admission checkpoints, local playback gate and platform resources                | Uncertain delivery identity/payload and server-owned facts                        |

Closing media fences new media work before collecting the fixed set of owned resources to release. An acquisition already in flight must either enter the tracked release set or close itself when its stale completion arrives; closing only attached handles is insufficient. Release acknowledgements decrease that set; durable admission is not counted as disposable media work. Shutdown/restart recovery continues to rely on existing durable evidence; this refactor does not introduce a new durable command journal implicitly.

## Formal guarantee boundary

The first proof candidate is admission conservation and response eligibility. Exact statements are drafted, falsified on reachable cases and reviewed by Astra under the owner's delegation before proof. Additional terminal/output laws require a concrete benefit; there is no target proof count.

Useful safety laws include valid-state preservation, exact identity matching, supersession and terminal-intent conservation. Positive laws must require eligible work to start, matching completion to advance and release acknowledgement to discharge the corresponding obligation. An implementation that drops every command must fail the specification.

Finite-trace preservation and conditional progress are separate claims. Eventual completion requires enabled owner work to be serviced, registered commands to execute or report failure, relevant completions/deadlines to arrive, and time to advance. Successful durable completion additionally requires an eventual successful storage opportunity. New input can legitimately supersede progress; closure progress applies after new media work has been fenced.

Bend does not prove Effect scheduling, OS behavior, provider quality, acoustic echo rejection, eventual storage repair or the bridge's token-to-content mapping. Compiled production integration and application-seam checks establish correspondence evidence separately. A model-only fallback must be named and cannot be presented as a proved TS implementation.

## Qualified compilation boundary

Run `pnpm check:bend` with Node 24, Bend **2.0.36** and `timeout` or `gtimeout` already available. It installs nothing. The installed compiler guide and `bend version` own the syntax/compilation contract; requalify another compiler version rather than silently accepting it.

This compiler natively emits an ES module with a default export through its `.mjs` output option. The earlier skill reference requiring a separate `bend-emit` wrapper does not describe this installed version. No additional emitter dependency is selected.

The current qualification covers the complete, exact synthetic identity-fixture grammar with one exported `Nat → Nat` function. Internal TypeScript declarations derive the export/binder names from that shape and reject changed bodies, whitespace variants, extra declarations and other signatures. Richer decision types require explicit ABI extension and qualification before product use; this is not a general-purpose binding generator.

The native JS numeric guard and its error wording disagree at the upper range. The qualified host accepts bigint tokens only within the conservative documented interval **0 through 2^48 − 1**, validates generated output and tests the endpoint. No wider numeric support is claimed.

The command materializes its approved pure identity law, proof, false-claim control, compiling semantic mutant, generated module and typed Effect consumer in a temporary directory and removes it afterward. Every proof check uses the five-second wrapper with hard process-group termination; a noncooperative compiler/child fixture checks this deadline. It proves the pure fixture identity and tests the real generated host mapping; it does not prove lifecycle policy or host correctness. It tests malformed inputs and repeated maximum-token calls without transcript, audio or credentials.

`test:harness` checks the narrow ABI generator. `check:bend` runs the real native qualification explicitly in #52. Production compilation/proof integration belongs to #53 onward, so current application startup and ordinary fast-test prerequisites are unchanged by #52.

## Migration receipts and checks

- #52 qualifies the real compiler/bridge boundary without changing current product policy.
- #53 exclusively moves pending input/eligibility policy. Existing response execution remains its sole implementation until #54 and must consume the start obligation without recomputing eligibility.
- #54 unifies response and delivery policy. #55 moves session/registry authority, with recognition temporarily behind an internal adapter that reports facts to the new owner.
- #56 removes that recognition adapter and mutable recognition policy. #57 replaces output coordination. #58 composes pure Swift capture/output policy and removes ViewModel lifecycle decisions.

At each milestone, delete the replaced policy, review changed owners and preserve tests through Conversation/Voice and Swift ports. Add direct bridge/law checks only where those interfaces cannot establish the property. The complete routine quality harness runs fast tests; slow scale checks are explicit manual commands. Physical audio qualification remains in its existing issues and is not a recurring contributor ritual.
