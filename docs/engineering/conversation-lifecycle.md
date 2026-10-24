# Conversation lifecycle protocol

**Purpose:** Define lifecycle authority, ordering and execution contracts for the functional conversation migration.
**Audience:** Implementers and architectural reviewers.
**Status:** Implemented protocol: admission in #53, response/delivery in #54, session/registry lifecycle in #55, provisional recognition in #56, output in #57 and the composed Swift feature in #58. Qualification evidence lives in the corresponding issue comments.
**Authority:** [Specification #51](https://github.com/dearlordylord/balabol/issues/51), its child issues and owner-delegated Astra review.
**Expected use:** Start Conversation or Voice state changes here, then follow the owner-local transition and interpreter.
**Lifecycle:** Update this protocol with changes to ownership, command acknowledgement or cancellation semantics. Do not describe planned guarantees as implemented.

## Authority and decomposition

Conversation owns pending input operations, response eligibility, the active response attempt, delivery authorization and its exact terminal persistence intent. Memory owns durable receipts and retained context through unii. A lifecycle snapshot is not a second durable transcript.

Each VoiceSession owns capture, provisional spoken-turn assembly and session-specific output. The voice registry owns start reservations and bounded retained-session identity. Segmentation, recognition assembly and output are named subtransitions within VoiceSession, not independent schedulers merely because they have separate source modules.

Start backend session changes in `voice/session-transitions.ts`, its named subtransitions and `session-state.ts`; `session-runtime.ts` interprets their commands through one mailbox. `registry-state.ts` owns reservation and retention decisions; `registry-runtime.ts` owns their resource execution. `recognition-transition.ts` composes segmentation, provisional turn assembly and recognition reservations inside the same session writer; `recognition-executor.ts` and `recognition-fragments.ts` own its physical work and PCM. `output-transition.ts` composes output authorization, phrase staging and release obligations under the same writer; `output-executor.ts` owns its publications, subscriptions, fibers and copied PCM. `session-transition-output.ts` maps commands and projections without becoming another output owner.

Microphone mute is an input boundary, not cancellation of the conversation. It advances the capture generation and resets classification so old microphone windows cannot enter after mute/unmute. Qualified audio already captured is sealed into the current turn, and its reserved, queued and running recognition work retains the turn generation until completion or explicit failure. Admission, reply generation and playback continue while muted. Recognition job identity therefore matches its turn generation, not the latest capture generation. If unmuted speech starts before the sealed turn settles, the single provisional-turn capacity rejects that new utterance with a recoverable `RecognitionFailed` capacity notice until quiet; it never merges it into the sealed turn or cancels that turn. Session closure, track retirement and capture failure still reset recognition; duplicate mute requests do not reset work.

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

## Native microphone intent lifetime

`VoiceMicrophoneLifetime.swift` owns the pure desired preparation/revision contract and its narrow serialized resource interpreter. This revision is independent of transport generations: a Room may be retired while explicit unmuted voice intent remains active. The feature reconciliation emits preparation intent before room-stop commands; initial Room capture waits for the matching physical preparation to settle. Permission, mute, End, platform availability, fatal failure and retirement constrain that intent. Muting while the host is unavailable still releases preparation without needing a Room or network request.

The LiveKit adapter alone calls the pinned SDK initialization and actual recording APIs. The pinned ADM distinguishes initialized input from running input: persistent preparation does not prevent Room teardown from clearing the running flag. The SDK-independent driver and fake preserve that distinction; Room cleanup invalidates running input and the still-authorized lifetime must renew it through the same fenced lane. It uses the same software AEC/AGC/noise suppression configuration as ordinary capture, without introducing a second AVAudioSession owner. Cancelled Room operations cannot discard preparation cleanup; serialized settlement fences stale acquisitions and compensates an enable that completes after a newer disable intent. A failed disable retains an explicit unknown/unreleased obligation rather than being treated as successful cleanup. Physical compensation is bounded; exhausted release is a visible result that explicit End/shutdown can retry. Shutdown waits for this lane and reports whether release was confirmed; the application cannot replace the owner on failure. A retired owner is never reactivated: once cleanup is confirmed, the composition root may recreate the current saved connection, preserving draft durability and never committing a cancelled server-address draft. Native preparation diagnostics retain safe phase/error evidence, never speech or offline PCM.

The current Quint-to-Swift models do not include SDK prepared recording or UIKit background execution eligibility. Their timer/effect traces assume the interpreter can execute supplied events; they cannot prove that a process remains runnable after physical audio teardown. Keep the existing modeled ordering/cancellation checks, deterministic lifetime boundary tests and task-specific physical locked-screen qualification distinct.

## Answer text admission

Conversation owns the plain-text admission boundary in `response-work.ts` and its `plain-text` transition. Validate provider events first, then normalize new answer deltas before posting them to the response owner. Response snapshots, persisted terminal text and Voice phrase staging consume that single append-only representation; presentation and synthesis must not apply independent text filters. Raw provider output keeps its own total bound, including removed syntax. Retained characters preserve their source language annotations at remapped UTF-16 offsets; formatting removal does not infer languages.

The incremental pure transition retains only undecided suffixes and fence/line context. Ordinary text is released immediately; line prefixes resolve at line boundaries, and unmatched inline constructs are retained on successful completion. Failed or cancelled work does not flush unpublished suffixes, and existing attempt/operation fences still reject late output. This is a conservative supported-Markdown boundary, not a full document renderer or a migration of historical receipts.

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

## Session expiry scheduling

`session-expiry.ts` selects the current join/control deadline and reserves an immutable timer identity. `session-expiry-executor.ts` owns the cooperative scoped sleep and reports its identity, deadline and observed time. Renew, mute and join reconcile the deadline; superseded wakes are inert, an early wake rearms, and closure clears authorization before cancelling the timer. Public registry lookups still apply the existing `now >= deadline` expiry check. Scheduling one relevant wake replaces repeated 20 ms no-op transitions without changing the deadline values, speech endpointing or reply polling.

## Output under the session writer

`output-state.ts` retains the exact delivery ticket, selected output epoch, suppressed handed admissions, immutable phrase state and outstanding resource obligations. Conversation remains authoritative for delivery authorization, completion deadlines and durable settlement. A deadline or interruption changes the logical projection immediately; it does not wait for noncooperative synthesis or drain cleanup. Suppression records retain each handed admission and its newest speech-fence sequence. Admission completion alone cannot release suppression: a correlated applied fence must cover that sequence. Rejected fences retain suppression until a later covering acknowledgement or permanent session retirement; a fresh admission itself requires an applied fence, keeping this set bounded.

One physical output lifetime occupies the execution slot until its matching work and publication release acknowledgements settle. Replacement selection and revocation happen immediately, while replacement playback waits for that slot. Reserved and cancelling work count as occupied. Every worker fact carries its operation and exact ticket/epoch; stale facts can discharge their own obligations but cannot select an output or authorize audio.

After installing the new state, the interpreter invalidates publication synchronously before dispatching asynchronous cancellation. The native publication gate also reads current Voice authorization and Conversation authorization at the actual capture boundary. Explicit client interruption waits for its correlated Conversation acknowledgement outside the writer. A failed delivery subscription closes the voice session honestly; a fresh scoped session restores its consumer.

Phrase staging preserves scalar-safe 800-character phrases, a 1,600-character staging buffer, punctuation and language-run splitting, and append-only authoritative reply text. Retention of that source text is separate from the staging bound. PCM stays in the executor: one copied packet token waits for actual capture completion and owner-selected release before the provider can advance. Packet identity, order, phrase frame budget and clean stream completion remain owner decisions.

Close waits for the fixed resource set's matching port acknowledgements. Failed publication close or unregistration retains the stable resource obligation and reserves a new release invocation with a 100 ms delay outside the writer. Only the matching invocation can settle it; a stale failure cannot reopen or overwrite its replacement. It does not claim that a LiveKit scope acknowledgement proves all deferred SDK/native cleanup finished; the adapter retains that existing responsibility. Unexpected output defects produce sanitized `outputDefect` technical metadata without exposing provider payloads or private causes.

## Swift feature transition

Start client voice changes in `VoiceFeatureTransition.swift`. Its immutable `VoiceState` composes capture, admission recovery, language capability and output values. Named capture, snapshot, platform, recovery and output subtransitions share this owner; they do not acquire independent task loops. `VoiceFeatureContract.swift` defines explicit input facts, reserved requests, work payloads and correlated results. Bootstrap UUID proposals enter at the ViewModel boundary, and correlated timer completions carry elapsed-time facts. Pure transitions neither generate UUIDs nor read clocks.

`VoiceViewModel` commits one returned feature value before interpreting its commands. Reentrant callback events wait in its concrete inbox until the current command batch is installed, so cancellation cannot miss a reserved Task. `VoiceTaskInterpreter` owns Tasks, dependency handles and platform barriers, and never reads feature state to decide what happens next. Cancellation leaves a command outstanding until its exact physical completion. Local suppression commits before synchronous platform fencing; asynchronous stop and remote acknowledgements follow outside the writer. End and shutdown do not erase unresolved admission checkpoints. A replacement capture must wait for older physical work that could still change the shared media adapter, even after the prior session's local disconnect completes.

A bootstrap that returns after cancellation still creates an exact session/incarnation release obligation. A failed closure attempt retains that obligation and schedules a correlated retry outside the writer, including during shutdown. Successful port acknowledgement discharges it; completion remains conditional on eventual successful closure or definitive producer-absence evidence.

Server receipts remain authoritative for accepted text and order. A selected output, acknowledged readiness and audio actually received remain distinct facts. Client transition tests do not establish physical playback, echo rejection or locked-screen behavior.

## Client event admission and pure boundaries

The Swift owners expose the same functional contract as the backend decision owners: a state value and an explicit event produce a new state value and command data. Start Conversation changes at its pure transition entry, and Voice changes at `transitionVoice`. Conversation may use `mutating` helpers on a local value copy; they are not a second state authority. UUID proposals, elapsed-time facts and provider results enter from the boundary. Resource handles, task registries and SDK buffers remain in interpreters/adapters, never the core state.

Each ViewModel installs the returned state before interpreting commands. An owner processes one event/command batch at a time; synchronous callbacks cannot interleave a later event into a partly installed batch. Asynchronous completions return correlated events. Main-actor isolation serializes access but does not alone prevent synchronous callback reentrancy.

Playback permission, canonical server facts and cleanup evidence are distinct authorities. A local cut revokes publication permission before asynchronous stop/control work. A structurally valid, fresh terminal observation for the selected response/output epoch updates its selected status despite that cut. It emits no prepare/readiness/playback authorization. Interrupted preserves interruption, Delivered does not erase a known local cut, and Failed remains a failure. A terminal output cannot regress to active, and an event for a different output cannot borrow this exception.

Identity scopes are not interchangeable. Request plus generation identifies local work; session plus backend incarnation identifies the producer lifetime; input delivery identifies accepted content; response plus output epoch identifies selected playback; sequence orders observations within its declared owner/stream. The presence of a field is not evidence of enforcement, and a new identifier is justified only by a demonstrated ambiguity. There is no global ordering counter across Swift and the backend.

### Admission inventory

| Owner / event class                        | Identity, validity and freshness                                                                                                            | State and command authority; lifecycle exceptions                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation local intent                  | Active generation and draft/send/retry/history phase guards                                                                                 | Reserve exact work before interpretation. End of voice does not end the enduring conversation. Shutdown denies new intents; drain is accepted only while stopping.                                                   |
| Conversation draft load/save               | Load matches the reserved loading request; save matches the serialized writing checkpoint                                                   | Load/reconcile valid local state. Save completion may finish during shutdown, independently of new capture generations; protected pending and confirmation writes cannot be discarded.                               |
| Conversation accepted voice receipt        | Valid user receipt from the Voice admission boundary; consistent delivery/record/position merge                                             | Merge accepted input without editing the independent draft or moving the history cursor. The ViewModel then requests current canonical reply state. A retained platform fence may resolve its exact response target. |
| Conversation input receipt                 | Exact sending request, valid user receipt, same delivery identity and text                                                                  | Merge accepted input, settle its checkpoint and follow its response. Uncertainty retains the original pending identity/payload.                                                                                      |
| Conversation current read / explicit retry | Exact reserved request, valid turn, latest accepted input                                                                                   | Read canonical state or explicitly request a distinct response attempt. Ordinary observation recovery never retries generation.                                                                                      |
| Conversation history/reconnect display     | Exact read request, bounded ordered page, cursor direction and unique message/record/position identities                                    | Merge durable evidence and retain independent pagination progress. A display probe cannot displace newer input, acquire a second observer or restart an answer.                                                      |
| Conversation reply observations            | Exact active observer, input and response identities; lower sequence ignored, equal sequence identical, text grows by prefix                | Replace active projection or merge terminal receipt. Terminal projection ends observation, fencing later active facts.                                                                                               |
| Conversation observation recovery          | Exact recovery request and accepted input; validate returned full snapshot                                                                  | Read-only recovery retains displayed text. A fresh authoritative read may reset response/sequence baseline after backend restart; this is not global monotonicity across incarnations.                               |
| Conversation older interrupted receipt     | Exact retained request-to-input association and matching valid terminal snapshot                                                            | Recover a bounded earlier durable receipt without replacing the current reply or starting another answer.                                                                                                            |
| Conversation platform interruption         | Bounded captured input set, exact fence request, matching input and selected/resolved response                                              | Interrupt only the captured response; retry invalidates its fence. Returned durable evidence must merge consistently or expose an explicit receipt failure.                                                          |
| Voice local intent / callback              | Non-retired phase guard; microphone/audio callback matches active capture request; platform callback matches retained platform observation  | Choose cut, capture, mute, producer closure or recovery. Speech additionally requires listening. Platform observation has its own lifetime, independent of capture generation.                                       |
| Voice operation completion                 | Exact outstanding request and compatible result constructor; ordinary currency includes generation, cancellation and retirement             | Settle only its obligation. Stale successful acquisition still needs its exact cleanup; an unrelated result cannot acknowledge another operation.                                                                    |
| Voice bootstrap/connect                    | Reserved request, start proposal/returned identity, generation, current phase/intent and origin                                             | A current acquisition may activate capture. A stale successful bootstrap is released; a stale connect is disconnected rather than installed.                                                                         |
| Voice checkpoint/restore/resolve           | Reserved operation, checkpoint revision or retained admission association                                                                   | Accepted input/checkpoint retention is independent of capture lifetime. Restore/resolve normal projections require a non-retired, non-cancelling owner.                                                              |
| Voice snapshot page/wire event             | Current session/incarnation; page sequence nondecreasing, wire sequence strictly increasing; validated event-specific identity              | Canonical pending admission and ordered events enter one owner. Interim is listening-only; handed acceptance can be recovered after End. Equal page sequence is not permission to replay an old wire event.          |
| Voice output observation                   | Selected response/output epoch, validated session payload, strictly newer output sequence; output projection admitted while listening/muted | Playback eligibility gates active selection/prepare. Matching selected terminal evidence is the explicit exception to playback suppression. Output freshness is not the wire/page counter contract.                  |
| Voice output prepare/audio/ready           | Exact prepared/current output identity; current capture request/generation and allowed phase; no local cut                                  | Reserve readiness or acknowledge actual received audio. Late preparation triggers stop cleanup, never renewed authorization.                                                                                         |
| Voice interrupt acknowledgement            | Exact outstanding operation and matching result kind                                                                                        | Acknowledges request completion, not canonical output projection. The existing implementation obtains output state from subsequent observation/snapshot recovery.                                                    |
| Voice timer                                | Exact reserved timer and purpose, plus phase/origin/generation as applicable                                                                | Retry/poll only for its retained owner. Cleanup retry timers may outlive retirement; a failed timer does not manufacture an elapsed fact.                                                                            |
| Voice stop/disconnect/seal/release         | Exact outstanding work, retained origin/revision and owner-specific phase checks                                                            | Discharge its own physical/closure obligation. Acknowledgements may arrive after retirement; they cannot authorize another output.                                                                                   |

### Observation convergence and assurance limits

The current interruption route is cut, synchronous local resource fence, remote interrupt, then completion of that control operation. Its returned snapshot is not currently installed as the output projection. Canonical evidence arrives through periodic snapshot observation, ordered wire validation and the output transition. That output projection is admitted while listening or muted; pause/end/retirement cannot be assumed to consume an output terminal event. Already handed accepted inputs and their retained checkpoints have separate recovery authority.

Receiving and processing valid terminal evidence for a selected output is a next-transition rule and needs no fairness assumption. Eventually receiving that evidence is conditional: the relevant owner remains live and eligible, work/timers are serviced, and observations or a recovery snapshot become available. Permanent disconnection, retirement or superseding intent do not satisfy those premises. A stale cleanup acknowledgement is accepted only for its retained obligation, not under an accept-all-stale rule.

The client inventory records existing guards rather than proving every combination. Quint models and Swift trace replay are developed in #61–#63; backend Bend proofs do not automatically extend to this projection. Protocol checks do not establish SwiftUI visibility, speech classification, physical echo rejection or locked-screen playback. The blank-transcript investigation remains separate.

## Executable client output contracts

Start output-policy changes at `quint-specs/VoiceOutput.qnt` and the corresponding Swift output transition. The stateless Core describes selection, accepted-input eligibility, cuts, observations, audio callbacks, failures and disconnection. Its machine records each explicit event, prior state, resulting state and command values. `VoicePreparation.qnt` adds only the preparation-completion boundary: real preparation/ready/stop obligations, request generations and explicit owner-context facts. It is not a model of how Voice acquires or changes that context; composed lifecycle coverage belongs to #62.

| Model boundary                                        | Actual Swift boundary                                        | Scope                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output Core initialization and all six event variants | `VoiceOutputState`, `transitionVoiceOutput`                  | Every output field and emitted Prepare/Suppress intent; replacing helpers are value construction, not separate lifecycle entry points.                                          |
| Preparation Project and Progress                      | `composeVoiceOutput`, `progressVoiceOutput`                  | Output intent, cancellation, physical-stop dependencies and preparation reservation.                                                                                            |
| Preparation Complete                                  | `completeVoice`, `outputVoicePrepared`                       | Matching preparation results/cancellation and retained ready/stop/interrupt settlement. Nonempty ready-success snapshot parsing remains canonical observation work for #62–#63. |
| Explicit Context facts                                | Test fixture construction of Voice capture/execution context | Checks admission given context; actual lifecycle transitions establishing it remain #62.                                                                                        |
| Wire validity and symbolic identity mapping           | Actual Swift Codable validation and test-only ITF mapping    | Fixed synthetic failure payloads; transcript strings, PCM and vendor internals are excluded.                                                                                    |
| Interpreter scheduling, transport and UI              | ViewModels, interpreters and adapters                        | Excluded from this output model; composed checks belong to #62–#63 and physical/UI qualification remains separate.                                                              |

The test-only ITF bridge under `ios/Tests/VoiceTests` translates finite symbols into separate UUID namespaces, invokes the actual Swift transitions and compares state plus command intent after every event. It does not decide which observations or completions should be admitted. The model-generated fixtures are synthetic, contain no conversation content, and run in ordinary fast Swift tests without Quint installed. Decoder/domain validation and projection checks are part of the trusted bridge boundary.

Run the manual acceptance path with the qualified **Quint 0.31.0** toolchain already installed:

```sh
node scripts/quint/check-output.mjs
```

This generates deterministic ITF scenarios with seed 61, replays them through Swift, requires rejection of abstract faulty-rule controls, temporarily restores two faulty Swift rules, requires semantic conformance failures, restores exact source bytes, and repeats the normal replay. It retains synthetic traces and command logs in the reported temporary directory. Run it alone, with no other Swift tests/builds or source edits: its mutation controls intentionally edit and restore the production transition. The ordinary fast tests never mutate source or invoke the checker.

For additional manual exploration, use fixed seeds and report the actual sample bounds:

```sh
quint run quint-specs/VoiceOutput.qnt --main VoiceOutput --invariant safety --seed 61 --max-samples 100 --max-steps 20
quint run quint-specs/VoicePreparation.qnt --main VoicePreparation --invariant safety --seed 61 --max-samples 100 --max-steps 20
```

A deliberately smaller exhaustive instance is `VoiceOutputFinite`: one output identity, sequence 0…1, all six statuses and cuts allowing either no input or input 2. It excludes replacement identities, audio callbacks, accepted-input events and disconnection; the larger replay/simulation models cover those paths. With an existing qualified Java/checker installation, run:

```sh
printf '%s\n' '{"maxHeap":"-Xmx1G","stackSize":"-Xss16m","workers":2}' > /tmp/balabol-quint-tlc.json
quint verify quint-specs/VoiceOutput.qnt --main VoiceOutputFinite --step finiteStep --backend tlc --invariant safety --tlc-config /tmp/balabol-quint-tlc.json --verbosity 3
```

This is a finite safety check, not a temporal or whole-client proof. Do not add exploration or TLC to mandatory commit hooks.

Passing a pinned trace corpus establishes conformance on those sequences. Random simulation samples additional sequences; it is not exhaustive verification. A checked finite model remains limited to its declared domains and environment assumptions, and does not prove all Swift executions. In particular, explicit preparation-context changes do not verify actual pause, retirement or reconnection transitions, and an abstract context combination is not evidence of a reachable application bug without a corresponding lifecycle path. Physical execution, UI visibility, speech quality and network availability retain the separate assurance limits above.

## Composed Voice lifecycle checks

`quint-specs/VoiceLifecycle.qnt` extends the output contract through the actual Voice owner. Its replay calls `transitionVoice` for every modeled event. It does not overwrite capture/generation context or synthesize calls to inner progress/completion helpers. The initial listening state is established by a real start → platform observation → checkpoint restore → permission → bootstrap → connection → language-result prefix, then compared with the model's independent initial value.

Replay compares resource/control/domain command intents. DEBUG trace commands are telemetry and are excluded from this protocol projection; focused interpreter tests check sanitized failure diagnostics separately. Admissions and checkpoints are loaded and empty in the model, and page speech contents, recognition and language contents are excluded; existing ViewModel and backend Memory tests retain those responsibilities.

Outstanding operations and retained handles are different facts. Completing platform observation removes its operation while retaining the callback handle. Likewise, dependency lists belong to emitted Run commands and the task interpreter, not an invented reducer-side dependency journal. Replay checks both the actual outstanding-operation projection and command dependencies.

Canonical terminal evidence is eligible while listening/muted with the matching live origin. Pause changes generation and clears the active origin while retaining the local cut; old-origin evidence is rejected. End clears output; shutdown also retires the owner. Recovery establishes a new origin before new output can prepare. Old completions must settle or preserve their own cleanup obligations without acquiring permission for the replacement.

Interpreter failures remain typed. `unexpectedOperation` identifies an unknown port failure without copying its payload; it is not automatically retried as a connection error. Expected failures retain their own category. A spontaneous `CancellationError` from a port is a failure unless its task was actually cancelled. The interpreter's throwing chain permits only `CancellationError`, preventing a future arbitrary throw from silently entering its cancellation branch. Interrupt and timer diagnostics retain sanitized failure categories. Interrupt completion still acknowledges control work rather than installing canonical output state.

The formal lifecycle model excludes permission denial, language/mute failures, mismatched bootstrap proposals and nonterminal sealing replies rather than silently approximating them by another phase. Application/adapter checks remain separate: permission denial has a ViewModel example, mismatched proposals have a real-transition rejection/cleanup example, and interpreter tests cover typed/unknown/cancellation classification. This model makes no general claim for the other excluded combinations. Retryable connection failures and output/resource-release failures are modeled. The explicit initial checkpoint/admission assumptions do not establish correctness of Memory internals.

Manual sampled exploration uses the same Quint 0.31.0 toolchain:

```sh
quint run quint-specs/VoiceLifecycle.qnt --main VoiceLifecycle --invariant safety --seed 62 --max-samples 100 --max-steps 20
quint run quint-specs/VoiceLifecycle.qnt --main VoiceLifecycle --step recoveryWitnessStep --invariant safety --witnesses reachedRecovery reachedPrepare reachedReady --seed 62 --max-samples 100 --max-steps 20
```

`preparationWitnessStep`, `muteWitnessStep` and `releaseWitnessStep` provide other targeted schedulers using actual events. These demonstrate reachability, not fair-scheduler liveness. The broad sampler uses two symbolic input/session/incarnation values, the output model's four identities and sequences 0…3; pinned regressions additionally exercise a previous sequence of 7. Generations and operation IDs follow the actual transition allocation during each bounded trace. This composed exploration is sampled, not an exhaustive check of its unbounded request space.

The manual composed acceptance path is:

```sh
node scripts/quint/check-lifecycle.mjs
```

It generates lifecycle traces with seed 62, replays them through Swift, exercises the existing ViewModel seams, rejects faulty terminal rules through the enclosing owner, restores exact production source and repeats normal replay. Like the output runner, run it alone; its controlled mutations are not part of fast tests or commit hooks. Small pinned lifecycle traces and port-level examples remain fast. Scheduler dependency checks and synchronous resource revocation tests do not establish that a physical speaker has stopped; that remains adapter/device qualification.

## Server/client observation convergence

Convergence concerns the same relevant output and a live eligible owner. A delayed observation may recover that owner's canonical terminal state; a Voice transport failure can retire its session and establish a new origin instead. Replacement is not recovery of the old owner's authorization. The latter path must reject old events and allow a new eligible response, as checked by the composed lifecycle scenarios.

An interrupt acknowledgement settles a request; it does not replace canonical observation. Local suppression is synchronous and remains effective while observation is unavailable. Once a fresh, valid terminal snapshot for the selected output reaches an eligible owner, terminal admission is immediate. Fair execution and eventual connectivity are assumptions for receiving that snapshot, not excuses for ignoring it after delivery. Independent channels have no shared global sequence.

The isolated real-server acceptance uses production HTTP routes, SQLite/unii, both Swift ViewModels and their production HTTP adapters. Its ports delay a Voice read before HTTP starts, lose the acknowledgement after the server commits interruption, and disconnect the Conversation reply observer. Subsequent reads recover the same output and durable receipt without another answer request. Summary generation remains independently pending through recovery and then completes when its provider is released. Reload checks durable history through another Conversation ViewModel; it does not claim a process-restart scenario.

Run this manual boundary check with Node 24 and the existing compiled Bend artifacts:

```sh
pnpm check:bend
node scripts/quint/check-convergence.mjs
node scripts/quint/check-convergence.mjs --controls
```

The controls path runs normal acceptance, restores the faulty terminal-evidence gate, requires a semantic terminal-convergence failure, restores the exact source and repeats normal acceptance. Run it alone without concurrent Swift builds or edits. Its fixture uses an ephemeral loopback server and temporary storage, never the personal backend, microphone or real model providers. The integration test skips unless that runner supplies its isolated endpoints; an opt-in run must execute and pass rather than accept a skip. Small output and composed-lifecycle replay remains the routine fast-check path.

### Finite communication model

`VoiceConvergence.qnt` composes the existing output core with server authority and explicit communication lanes. Interrupt requests and acknowledgements have capacity one; polls have one outstanding request and up to two FIFO responses. One independent delayed response permits cross-channel reordering. The network permits one observation loss, one outage and one duplicate. Quiescent poll identities are reused abstractly; concurrent operation correlation is covered by the composed Swift lifecycle model. Snapshot pages are created by server reads, never by assigning the desired client result.

The model starts after accepted input X and its first answer exist. It checks their retention and prevents communication from generating another answer; actual durable acceptance and summary execution belong to the real-server test. The general instance permits replacement Y, retirement, Delivered and Failed. The stable instance fixes the relevant owner and output X for conditional terminal convergence. Weak fairness applies to cut, interrupt service, poll issuance/read/delivery and link recovery. It does not promise progress with a permanently unavailable network, abandoned executor, lost non-retried interrupt request or superseding owner.

Use the already-qualified Quint **0.31.0**, TLC **2.19**, Apalache compiler **0.51.1** and installed Java. With Node 24 selected, explicitly invoking the Quint JavaScript entry also avoids a package-manager shebang selecting another Node:

```sh
balabol_quint_cli="$(command -v quint)"
node "$balabol_quint_cli" typecheck quint-specs/VoiceConvergence.qnt
node "$balabol_quint_cli" test quint-specs/VoiceConvergenceTest.qnt --main VoiceConvergenceTest --seed 63 --max-samples 1
cat > /tmp/balabol-quint-tlc.json <<'JSON'
{"maxHeap":"-Xmx1G","stackSize":"-Xss16m","workers":2}
JSON
node "$balabol_quint_cli" verify quint-specs/VoiceConvergence.qnt --main VoiceConvergenceStable --backend tlc --invariant safety --temporal terminalConvergence --tlc-config /tmp/balabol-quint-tlc.json --verbosity 3
node "$balabol_quint_cli" verify quint-specs/VoiceConvergence.qnt --main VoiceConvergence --backend tlc --invariant safety --tlc-config /tmp/balabol-quint-tlc.json --verbosity 3
```

Negative controls must produce counterexamples. Repeat the temporal command without `--invariant safety` for `VoiceConvergenceDropTerminal` and `VoiceConvergenceResurrection`: the same fairness premise must reject each faulty projection on progress itself. On normal `VoiceConvergenceStable`, replace `terminalConvergence` with `unfairConvergence`; the expected counterexample demonstrates why removing fairness invalidates the progress claim. Deterministic scenarios exercise loss/recovery, acknowledgement authority, duplicates, wrong incarnation, replacement, all terminal statuses and retirement. These finite checks remain manual, with exact domains, reachability and checker results recorded in #63; they do not prove arbitrary network histories or the whole application.

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

## Subscription answer recovery progress

Automatic transient recovery repeats one immutable subscription model request, before that request has released output. It does not create a new Conversation response attempt, replay an agent run or execute completed tools again. Two scheduled retries remain inside the existing request/run deadlines. Intentional cancellation cancels the request and backoff; authentication, quota, protocol and application-limit failures remain terminal without automatic retry. Summary jobs keep their separate policy.

Retry notifications enter the same correlated provider-event boundary as answer deltas. A matching active generation advances the reply sequence and projects bounded attempt counters; stale/cancelled notifications cannot revive a response. Swift observes this server state and never initiates inference retries itself. Retry cues are deduplicated by response identity and observed sequence, because separate model steps can have equal local attempt counters. Live final failure is distinct from interruption and from restored history. Cue rendering shares the existing managed echo-reference path and never changes microphone intent.

## Capture continuity under input pressure

Voice owns a bounded microphone ingress separately from room lifetime and assistant output. Overflow or excessive local queue residence invalidates the current ingress epoch immediately and coalesces one capture-gap event. Old queued PCM and late classification results cannot become current speech. The owner advances capture generation and resets activity/provisional recognition before admitting post-gap audio. Processing remains serial; upstream LiveKit buffering is not an end-to-end freshness guarantee.

A capture gap preserves active session, output authorization, mute intent, finalized recognition jobs and already handed admissions. Only unsubmitted incomplete speech is abandoned; missing audio is never sealed as a complete utterance or stitched across the gap. The native recoverable notice names only a genuinely abandoned utterance and cannot resolve or revoke an accepted input. Genuine transport loss remains separate.

The current Quint client models explicitly abstract PCM, classification and backend frame queues. Their conformance checks remain necessary for modeled lifetime/ordering behavior; they do not prove capture-pressure recovery. Delayed-activity Voice integration tests, generation-fence tests, recognition transition tests and native projection tests exercise this boundary.
