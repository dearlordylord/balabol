# Conversation lifecycle protocol

**Purpose:** Define lifecycle authority, ordering and execution contracts for the functional conversation migration.
**Audience:** Implementers and architectural reviewers.
**Status:** Accepted target protocol; admission is integrated in #53, response/delivery in #54, session/registry lifecycle in #55 and provisional recognition in #56; #57–#58 migrate the remaining output and Swift owners.
**Authority:** [Specification #51](https://github.com/dearlordylord/balabol/issues/51), its child issues and owner-delegated Astra review.
**Expected use:** Start Conversation or Voice state changes here, then follow the owner-local transition and interpreter.
**Lifecycle:** Update this protocol with changes to ownership, command acknowledgement or cancellation semantics. Do not describe planned guarantees as implemented.

## Authority and decomposition

Conversation owns pending input operations, response eligibility, the active response attempt, delivery authorization and its exact terminal persistence intent. Memory owns durable receipts and retained context through unii. A lifecycle snapshot is not a second durable transcript.

Each VoiceSession owns capture, provisional spoken-turn assembly and session-specific output. The voice registry owns start reservations and bounded retained-session identity. Segmentation, recognition assembly and output are named subtransitions within VoiceSession, not independent schedulers merely because they have separate source modules.

Start backend session changes in `voice/session-transitions.ts`, its named subtransitions and `session-state.ts`; `session-runtime.ts` interprets their commands through one mailbox. `registry-state.ts` owns reservation and retention decisions; `registry-runtime.ts` owns their resource execution. `recognition-transition.ts` composes segmentation, provisional turn assembly and recognition reservations inside the same session writer; `recognition-executor.ts` and `recognition-fragments.ts` own its physical work and PCM. `ReplyAudio` remains the output migration boundary until #57; it cannot write session lifecycle fields.

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
| Execution invocation             | Distinguishes physical dispatch attempts while a retried logical obligation keeps its identity     |
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

Capture continues while a speech fence awaits acknowledgement. A quiet, complete recognition turn may reserve bounded provisional capacity, retaining its original generation and fence identity; that fence retains the source sequence. The turn remains extendable by a qualified speech onset until actual handoff, including while its fence acknowledgement is pending. Only the matching applied fence permits handing that payload to Conversation; rejection cannot masquerade as acknowledgement. Mute, replacement or closure may discard this unhanded provisional set, while already handed admission keeps its host lifetime. An older fence rejection cannot reset a newer spoken turn.

Delivery registration installs its scoped subscription and initial snapshot atomically. Started and invalidated notifications carry exact registration, ticket, response and input identities. Notification delay cannot grant publication permission: the resource adapter reads current authorization after each asynchronous wait and immediately before enqueuing each native audio frame. Its guard performs no transitions or I/O and returns false after retirement or detach. An acquisition that finishes after revocation closes its stale resource. Each ticket has an interpreter-owned AbortController. After committing logical revocation, the owner synchronously aborts that controller before dispatching notifications. The native adapter’s abort listener only invalidates its publication and clears queued RTC audio; domain projections still consume typed events. The adapter checks an already-aborted signal on attachment, removes the listener on close and cannot report successful capture or drain after cancellation. Controllers are never reused.

The authorization check must hold at the actual publication boundary, including after asynchronous synthesis or readiness waits. Checking only when a command is dequeued permits a stale capture to publish later. The resource gate is synchronously revocable; its private implementation does not make independent domain policy.

## Completion and interruption

Cancellation first records logical invalidation and revokes resource authorization, then requests physical cancellation. A delayed or noncooperative worker may finish, but its old generation/operation/response cannot change the selected state or release stale audio.

Conversation selects completion versus interruption in its own event order. Once the terminal persistence intent is selected, it retains the exact outcome and immutable payload identity through storage failure and retry. A successful matching receipt establishes the durable terminal result. An explicit retry under existing product rules is a distinct response attempt.

A terminal persistence operation keeps its identity, immutable payload and selected outcome across retries. Each dispatch has a separate invocation identity. A transient failure may change execution status only for the current invocation; replaying an old failure cannot reopen a newer in-flight write. An exact durable acknowledgement may settle the stable intent even when produced by an earlier invocation: durable evidence and transient execution failure have different correlation rules. An explicit retry of the answer itself creates a new response attempt, rather than reusing the terminal persistence operation.

Provider failure and observer cancellation retain the existing nondurable Failed projection; they do not select an Interrupted persistence intent, including when a later input arrives. An active delivery interruption or failure selects Interrupted, while a storage failure after selection retains the already selected intent. These cases must remain distinct.

Generated text, durable terminal text and delivered audio remain different evidence. Saved interrupted text may contain words not heard by the owner. Neither recognition nor output state may manufacture durable receipts or word-level heard attribution.

## Lifetime and closure

| Lifetime         | Owns                                                                                          | What closure must preserve                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Host             | Conversation execution, Memory writer and independent summaries, handed admission/recovery    | Exact unresolved durable obligations until settlement or honest recovery evidence |
| VoiceSession     | Media connection, capture/classification/recognition/output workers and publication resources | Host-owned admission; durable input and history                                   |
| Response attempt | Answer work and its delivery authorization/deadline                                           | Memory summaries and already accepted input                                       |
| Client feature   | Tasks, draft/admission checkpoints, local playback gate and platform resources                | Uncertain delivery identity/payload and server-owned facts                        |

Closing media fences new media work before collecting the fixed set of owned resources to release. An acquisition already in flight must either enter the tracked release set or close itself when its stale completion arrives; closing only attached handles is insufficient. Release acknowledgements decrease that set; durable admission is not counted as disposable media work. Shutdown/restart recovery continues to rely on existing durable evidence; this refactor does not introduce a new durable command journal implicitly.

The registry reserves a start identity before acquiring session resources. Identical concurrent starts share that reservation; conflicting starts receive a decision without waiting for acquisition. Logical closure and physical release are distinct: a closing session remains retained until its fixed resource obligations settle. An ended session is evictable only after release completes and no handed admission remains unresolved. Factory failure acknowledges acquisition cleanup before removing its reservation.

Session retention facts carry a monotonically increasing session-local revision assigned by the session writer. The registry ignores older or duplicate facts, so delayed delivery cannot replace pending admission or closure with an earlier projection. Neither owner waits inside its writer for the other owner's acknowledgement. Host shutdown settles waiting start callers and fences installation before interrupting acquisition; a late acquired handle is disposed rather than published.

## Formal guarantee boundary

The first proof candidate is admission conservation and response eligibility. Exact statements are drafted, falsified on reachable cases and reviewed by Astra under the owner's delegation before proof. Additional terminal/output laws require a concrete benefit; there is no target proof count.

Useful safety laws include valid-state preservation, exact identity matching, supersession and terminal-intent conservation. Positive laws must require eligible work to start, matching completion to advance and release acknowledgement to discharge the corresponding obligation. An implementation that drops every command must fail the specification.

Finite-trace preservation and conditional progress are separate claims. Eventual completion requires enabled owner work to be serviced, registered commands to execute or report failure, relevant completions/deadlines to arrive, and time to advance. Successful durable completion additionally requires an eventual successful storage opportunity and fresh identities within the qualified host token range. Counters never wrap; the response bridge rejects out-of-range identities rather than providing a typed allocator-exhaustion recovery policy. New input can legitimately supersede progress; closure progress applies after new media work has been fenced.

Bend does not prove Effect scheduling, OS behavior, provider quality, acoustic echo rejection, eventual storage repair or the bridge's token-to-content mapping. Compiled production integration and application-seam checks establish correspondence evidence separately. A model-only fallback must be named and cannot be presented as a proved TS implementation.

## Recognition under the session writer

`recognition-state.ts` holds immutable onset/segment, turn, queued chunks, operation reservations and fragment ownership. `recognition-transition.ts` returns command data; it does not start fibers, call providers or hold writable PCM. The session composes its onset and complete-turn decisions with the existing Conversation fence and admission protocol.

Preserve the established sample policy: 960 samples for qualified onset, 16,000 classified quiet samples for a turn boundary and 160,000 samples per recognition chunk. Quiet carries across chunk rollover. A turn has at most 30 chunks; every completed chunk counts `text.length + 1` toward the 100,000-unit text budget, including empty results, and at most 1,000 spans are retained. Assembly preserves capture order, original nonempty text and shifted UTF-16 spans. A provider Final becomes a chunk result only after clean stream completion; a subsequent stream failure rejects the entire incomplete turn.

Reserved, running and cancelling operations all count toward the same two physical recognition slots. The transition reserves a slot before dispatching its command. Reset and failure fence the turn before requesting cancellation, retaining each operation and its PCM references until its exact settlement acknowledgement. Late work can release its old reservation without contributing text or errors to a newer turn. A required-chunk failure rejects the whole provisional turn and suppresses its remaining speech until quiet; a surviving prefix is never admitted.

PCM stays in an adapter-owned fragment store. Pure slice coordinates describe ownership; sealing a chunk transfers its slice group without copying accumulated PCM through the reducer. Only transition-selected release commands retire fragments. Materialization creates independent request bytes, and the provider cannot mutate retained source samples. The interpreter installs physical work before spawning it and reports settlement after stream finalization. Expected failure, interruption and defects remain distinct settlement facts, including a finalizer defect combined with a provider failure. Defects produce sanitized `recognitionDefect` technical metadata while retaining the existing recoverable recognition notice; private cause content is not logged. The interpreter cannot choose capacity, turn completion or recovery policy.

## Qualified compilation boundary

Run `pnpm check:bend` with Node 24, Bend **2.0.36** and `timeout` or `gtimeout` already available. It installs nothing. The installed compiler guide and `bend version` own the syntax/compilation contract; requalify another compiler version rather than silently accepting it.

This compiler natively emits an ES module with a default export through its `.mjs` output option. The earlier skill reference requiring a separate `bend-emit` wrapper does not describe this installed version. No additional emitter dependency is selected.

The synthetic identity fixture remains a compiler smoke check. The production admission and response-terminal boundaries additionally support their concrete source-derived ADTs, constructor tags, `Bool` and `Nat`; unsupported declarations fail closed. Generated declarations and the native module come from the same source snapshot. This is a deliberately restricted binding generator, not a general-purpose Bend SDK.

The native JS numeric guard and its error wording disagree at the upper range. The qualified host accepts bigint tokens only within the conservative documented interval **0 through 2^48 − 1**, validates boundary values and tests the endpoint. No wider numeric support is claimed.

`src/conversation/admission-core` owns the production transition, independent specification, approved laws and proofs. Conversation interprets its commands; TypeScript does not independently select eligibility. Origin source sequence and Conversation revision are both checked by the core. A processed fresh text intent or speech fence can invalidate a delayed voice acceptance. Repeated accepted deliveries do not create a new response or advance eligibility.

The host reserves an immutable payload claim before durable lookup and retains it through uncertain storage failure. A matching durable receipt acknowledges input independently of capture closure. Superseded input is retained and settles as Interrupted without starting a provider or media delivery. Pending persistence and revocation commands remain recovery obligations until settlement; dispatch alone does not discharge them. #54 replaces the separate Replies and ReplyDelivery authorities with response transitions interpreted by the same Conversation mailbox; its acceptance evidence remains tracked in that issue. Conversation permits at most two unresolved fresh input reservations, reusing the prototype’s capacity of two pending voice inputs. New identities receive typed ReplyBusy while capacity is full or an uncertain operation requires recovery; an existing matching identity remains retryable, and fences remain processable. This bounds retained payload claims without discarding obligations.

`check:bend` runs native fixture qualification, concrete ADT qualification, bounded production proofs, finite transition/clock cases and compiling semantic-mutant controls. Each proof check has a five-second hard process-group deadline. False claims and mutant proofs must fail while their original controls pass. Temporary controls are removed afterward. No transcript, audio or credentials enter these checks.

`src/conversation/response-terminal-core` owns the selected terminal-intent transition, independent specification, approved laws and proofs. It preserves attempt, logical operation, payload token and outcome across physical write retries; only a strictly fresher invocation dispatches a retry. Conversation validates each actual receipt against the selected immutable payload before providing the core with acknowledgement evidence.

Build, compiler, Effect and behavior gates prove and compile both production cores from checked snapshots before use. Build copies the compiled modules into `dist`; generated source artifacts are ignored by Git. Pre-commit also runs `check:bend`. Contributors therefore need the already-qualified native tools for normal product checks. The harness tests that changing the implementation without a valid proof blocks compilation and that the built distribution runs independently of source-generated files.

The approved laws establish selected transition safety and conditional single-step progress. They do not establish Effect scheduling, payload-byte correspondence, eventual storage recovery or unconditional liveness. Application tests through Conversation and Voice with real Memory/SQLite cover runtime ordering and correspondence separately.

## Migration receipts and checks

- #52 qualifies the real compiler/bridge boundary without changing current product policy.
- #53 exclusively moves pending input/eligibility policy. Existing response execution remains its sole implementation until #54 and must consume the start obligation without recomputing eligibility.
- #54 unifies response and delivery policy. #55 moves session/registry authority, with recognition temporarily behind an internal adapter that reports facts to the new owner.
- #56 removes that recognition adapter and mutable recognition policy. #57 replaces output coordination. #58 composes pure Swift capture/output policy and removes ViewModel lifecycle decisions.

At each milestone, delete the replaced policy, review changed owners and preserve tests through Conversation/Voice and Swift ports. Add direct bridge/law checks only where those interfaces cannot establish the property. The complete routine quality harness runs fast tests; slow scale checks are explicit manual commands. Physical audio qualification remains in its existing issues and is not a recurring contributor ritual.
