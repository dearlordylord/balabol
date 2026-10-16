# Functional conversation lifecycle and selective formal guarantees

**Purpose:** Specify the functional lifecycle refactor and proportionate use of Bend law-driven development.
**Audience:** Implementers and architecture reviewers.
**Status:** Accepted direction; implementation and proofs pending.
**Authority:** Owner discussion and delegated Astra architectural review; [issue #51](https://github.com/dearlordylord/balabol/issues/51) is the implementation authority.
**Expected use:** Start lifecycle changes from these ownership, execution and verification requirements.
**Lifecycle:** Maintain with the published issue when lifecycle ownership or guarantee scope changes.

## Problem Statement

The single enduring conversation must accept input reliably, yield to new speech and never revive stale output. Current mutable lifecycle objects distribute decisions across fields, callbacks and asynchronous methods. Correctness depends on update order across recognition, admission, response generation and playback. Pure reducers improve visibility but alone establish neither race freedom nor progress.

The owner wants immutable functional domain logic, explicit machine boundaries and selective formal guarantees for consequential safety and progress rules. Proof work must remain proportionate; proving the entire application is not a goal.

## Solution

Use pure transitions over immutable domain values, with Effect interpreters on the backend and task interpreters inside Swift MVVM slices. Keep one writer per lifecycle owner and make operation identity, cancellation, completion and cross-owner ordering explicit. Apply Bend law-driven development first to the small Conversation admission and response eligibility core. Extend proof coverage only where it resolves a concrete risk that ordinary types and behavioral checks leave insufficiently established.

## User Stories

1. As the owner, I want one enduring conversation, so that voice sessions never fragment memory.
2. As the owner, I want accepted input retained across interruption, so that speaking again cannot erase my message.
3. As the owner, I want pending durable admission to survive capture closure, so that ending voice does not silently lose handed input.
4. As the owner, I want new speech to revoke stale response eligibility, so that an earlier pending input cannot unexpectedly speak over me.
5. As the owner, I want eligible accepted input to produce a response obligation, so that safety cannot be implemented by doing nothing.
6. As the owner, I want obsolete recognition and playback events ignored, so that cancellation remains effective despite late callbacks.
7. As the owner, I want interrupted replies attributed honestly, so that saved text is not presented as proof I heard it.
8. As the owner, I want summaries independent of response cancellation, so that interruption does not stop memory work.
9. As the owner, I want recoverable errors and explicit unresolved work, so that failures neither kill the backend nor disappear silently.
10. As the owner, I want existing conversation behavior preserved, so that an architectural refactor does not introduce unrelated UX changes.
11. As an implementer, I want immutable state and pure transitions, so that decisions can be replayed and inspected.
12. As an implementer, I want machines separated by authority and lifetime, so that modules do not become competing writers.
13. As an implementer, I want capacity reserved before work starts, so that asynchronous scheduling cannot exceed limits.
14. As an implementer, I want correlated command results, so that stale or duplicate completion cannot settle different work.
15. As an implementer, I want nonblocking owner loops, so that slow inference or storage cannot prevent handling interruption.
16. As an implementer, I want explicit resource release obligations, so that closure can make measurable progress.
17. As a reviewer, I want safety laws paired with positive progress laws, so that inert implementations cannot pass.
18. As a reviewer, I want liveness assumptions stated, so that a proof of transitions is not mistaken for a guarantee about the OS or network.
19. As a reviewer, I want production to call the proved decision core, so that a disconnected model is not advertised as proved software.
20. As the owner, I want Astra to review laws without another owner interview, so that formalization can proceed within agreed behavior.
21. As an implementer, I want discoverable structure and executable fences, so that subsequent features follow the same discipline.

## Implementation Decisions

### Ownership and functional structure

- Conversation owns input operation status, response eligibility, response lifecycle, delivery authorization and the exact pending terminal persistence intent. Merge current response and delivery policy into this authority.
- Each VoiceSession owns capture, provisional recognition assembly and session-specific output state. Compose named subtransitions within that owner; a separate module does not require its own actor, queue or runtime.
- Keep Conversation separate from VoiceSession because durable admission, text interaction and the enduring conversation outlive media capture. Memory remains the sole durable conversation authority through unii; background summaries retain their independent lifetime.
- Keep the voice registry limited to start identity, reservations, retention and session resource construction. Give its state one writer and avoid external writes into session internals.
- Transitions take immutable state and explicit events and return new state plus command data. No domain class instances, mutable collections, hidden clocks, random identity creation, callbacks or resource handles belong in the pure core. Explicit deterministic identity counters are permitted where their uniqueness scope is sufficient.
- Swift composes capture and output policy in feature transitions. ViewModels interpret commands and project state; they do not independently decide lifecycle policy. Bring identity creation outside transitions. Platform reference types and resource machinery remain in adapters.
- Operational resources remain private to interpreters: fibers, queues, processes, sockets and audio buffers. Use opaque fragment identities instead of repeatedly copying PCM through transitions. Define immutable payload ownership and explicit release; opaque identities do not prove the referenced payload content.
- Preserve existing external contracts unless a required change is explicitly recorded. No persistence migration or new public endpoint is assumed merely to refactor internal policy.

### Execution and ordering

- Every public request, callback, timer and asynchronous completion enters its owning event loop. Only that loop replaces domain state. Reserve operations and capacity before executing commands.
- Do not await slow I/O while holding the owner loop. Correlate completions with operation identities; callers may wait on operation-specific results outside the transition loop.
- Fence logically before requesting physical cancellation. Ignore late events by generation, response and operation identity even if resource cancellation is delayed. Resource publication must enforce the current gate before releasing audio.
- Register pending admission intent before asynchronous persistence. New speech can revoke its reply eligibility without revoking the obligation to establish durable acceptance or definitive rejection.
- Preserve handed admission under the host lifetime rather than the disposable capture scope. Capture closure releases media resources while admission recovery remains resolvable.
- Define completion-versus-interruption ordering at the Conversation owner. Once a terminal persistence intent is selected, retries retain its exact outcome and payload identity.
- Define an acknowledged, revision-correlated protocol between VoiceSession and Conversation. Do not assume two event loops share an atomic instant. Document the point from which each fence applies and preserve immediate local audio suppression. Test the admission/onset race through the actual protocol.
- Logical operation uniqueness permits interpreter retries with the same identity; it does not promise exactly-once network execution.

### Selective Bend scope

- First candidate: the small admission, response eligibility and terminal obligation decision core within Conversation. Keep providers, streaming text, transcripts, SQL, timers and media I/O in their existing owners.
- A second candidate is output authorization and stale-publication fencing, only after the first integration demonstrates value. Do not require every reducer, parser or helper to acquire proofs.
- Prefer production calls to the compiled Bend core, with generated internal host types and a tested bridge. Keep external Effect Schema wire validation; do not duplicate domain policy in the bridge or retain a separately maintained TS decision engine as if it were proved.
- Qualify the installed toolchain and actual JS integration before committing to the migration shape. If a model-only fallback is necessary, explicitly document the implementation-to-model relation and limits: differential testing is evidence, not a universal refinement proof.
- Do not introduce XState, TCA, another scheduler or another formal verification tool as a prerequisite. Any later addition needs a concrete unmet need.

### Candidate laws and proof boundary

These are law directions, not completed executable statements or proofs. Astra reviews exact statements, validity predicates, assumptions and counterexamples before proofs under the owner's explicit delegation.

- Validity: transitions preserve valid state; boundary validation is sound, complete, meaning-preserving and reports a real defect.
- Admission conservation: capture closure, media disconnect and reply interruption cannot erase unresolved handed admission.
- Supersession: after the applicable fence is processed, an older pending intent cannot issue a new response start; matching acceptance still retains the input.
- Eligibility completeness: eligible acceptance with prerequisite obligations settled creates exactly one logical start obligation for the response attempt.
- Exact settlement: only matching, admissible completion settles the expected operation; matching completion must advance it.
- Terminal conservation: retries preserve the selected terminal outcome and immutable payload identity. Explicit reply retry is a distinct attempt, not resurrection of a terminal attempt.
- Cancellation independence: invalidated response attempts cannot issue further generation or publication authorization while waiting for cancellation acknowledgement.
- Progress: matching success advances to the specified phase and required command; matching failure produces the specified observable recovery or failure state. Enabled explicit retry cannot silently drop the obligation.
- Closure: closure fences new media work and emits release obligations; matching acknowledgements decrease the fixed outstanding set until closed. Durable admission is outside that disposable resource set.
- Capacity: reserved work respects existing bounds, and available capacity selects eligible queued work under an explicit ordering rule.

Prove selected safety properties over arbitrary finite traces where appropriate. State conditional progress and decreasing measures separately. A complete finite witness trace is not proof that real acknowledgements eventually arrive.

Any eventual-completion claim must name its assumptions: enabled work is eventually serviced; commands execute or report failure; relevant operations settle or deadlines fire; time advances; required events arrive; new input does not indefinitely invalidate progress. Successful durable completion additionally requires an eventual successful storage opportunity. Do not claim these environmental assumptions are proved by Bend transition proofs.

### Delivery sequence

1. Freeze ownership, cancellation lifetimes, state validity and the cross-owner event protocol; identify the few highest-value proof obligations.
2. Qualify the Bend-to-JS boundary without changing product behavior, then draft and falsify candidate laws using reachable cases and planted bugs.
3. Obtain Astra law review, freeze approved statements and prove the selected core. Run proof checks under the skill's five-second limit; require the checker to accept all proofs without unsafe or foreign proof dependencies.
4. Demonstrate compiling semantic mutants are rejected for the intended law, rather than merely failing syntax or unrelated helpers.
5. Integrate the authoritative core behind the existing Conversation interface and delete the replaced policy. Convert remaining Voice and Swift lifecycle orchestration to immutable transitions and explicit interpreters in reviewable milestones.
6. Keep decisions discoverable from owner-local structure, contracts, tests and concise guide links. Do not create a generic actor framework or a parallel legacy path.

## Testing Decisions

- Preserve the established highest behavioral seams: Conversation and Voice application interfaces with real unii and temporary SQLite, deterministic provider Layers and controlled completions. Swift tests exercise feature intents and observable projections through existing ports.
- This continues the owner's accepted behavioral-test approach. Add direct law checks only for the selected pure core and bridge checks where the application seam cannot establish correspondence. Avoid new public test-only interfaces.
- Assert saved messages, response eligibility, terminal outcomes, recoverability and absence of stale publication. Avoid assertions about private fields, class shape or incidental helper calls.
- Prior art includes existing long-turn, admission/onset race, output fencing, reply delivery recovery, duplicate delivery, memory independence and Swift lifecycle tests.
- Cover reordered recognition results; reservation races; mute/end during classification; resumed speech during admission; deadline versus audio drain; interruption versus terminal commit; duplicate settlement; stale readiness; storage failures and retry; shutdown with pending admission.
- Use generated event histories for bounds, validity, terminal monotonicity and stale-event inertness. Replay frozen inputs for deterministic transition behavior. Control asynchronous work through provider ports and virtual time where available.
- Falsify laws before proving. Require semantic controls such as dropping every command, always permitting a start, deleting pending admission on close, accepting another ticket, ignoring success and never releasing reservations. Record which approved law each mutant violates.
- Verify the compiled artifact and actual bridge at current product bounds. If payloads are represented by opaque IDs, test their identity-to-content mapping and lifetime explicitly.
- Run focused gates per milestone and the complete prescribed quality harness on the final candidate, plus required Swift concurrency and behavioral checks. Proof success does not replace integration checks.
- Keep physical-device audio qualification separate. Do not add recurring manual iPhone, headset or call rituals to automatic contributor guidance. Existing physical acceptance issues remain truthful about their outstanding evidence.

## Out of Scope

- Proving the whole application, scheduler fairness, OS behavior, acoustic echo rejection, model accuracy or successful recovery from permanently unavailable storage.
- Proofs for every pure function; rewriting unrelated parser, storage or provider implementations solely to eliminate class syntax.
- Replacing unii, Yielded, Effect, SwiftUI/MVVM or the selected speech providers.
- New conversation features, altered endpointing heuristics, automatic replay or changed user-facing retry policy.
- New tool installations, dependency additions, product refactoring or claims of completed proofs as part of publishing this specification.

## Further Notes

The owner explicitly authorized Astra to review laws in place of the skill's default owner approval loop. Material product behavior or scope changes remain owner decisions; drafting laws must not invent them.

Use proofs where they establish consequential safety or conditional progress that remains hard to trust from ordinary engineering checks. Keep the investment bounded by useful guarantees, not proof count. No proof, compiled integration or liveness qualification is claimed by this specification.
