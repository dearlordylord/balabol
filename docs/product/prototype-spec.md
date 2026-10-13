# Balabol: extensible iOS prototype with fake providers

**Purpose:** Specify the minimum implementable Balabol prototype.
**Audience:** Product owner, implementers and reviewers, including coding agents.
**Status:** Published; testing seams confirmed by the owner on 2026-10-13.
**Authority:** Accepted implementation contract published as [Balabol: extensible iOS prototype with fake providers](https://github.com/dearlordylord/balabol/issues/1). This file is its synchronized local copy.
**Expected use:** Implement the prototype and assess acceptance; research is advisory.
**Lifecycle:** Keep this local copy synchronized with the published issue; review when scope, ownership, provider contracts or acceptance criteria change.

## Problem Statement

The owner wants a personal assistant that can be used as a live conversation on an iPhone, including with the screen locked, with one enduring memory across sessions. They want an extensible prototype with sound domain ownership, Swift MVVM and vertical capability slices, rather than a disposable demo or a large feature set.

Real voice and subscription model behavior is not yet qualified. Installing engines, downloading weights or running inference is explicitly deferred. The initial prototype must make the complete application behavior exercisable through deterministic fake providers whose interfaces reflect validated real-world contracts.

## Solution

Build an iOS-first client and a local TypeScript/Effect backend, reachable through the owner's existing Tailscale network. There is exactly one conversation, continued through multiple voice sessions and text messages. The sole memory implementation is @firfi/unii, backed by durable injected storage.

Compose fake speech-recognition, speech-synthesis, answer and summarization adapters through Effect Layers. The client and application workflow must work through the same interfaces that later real adapters will implement. Make demo behavior explicit: scripted recognition and model output do not imply live understanding, and audio fixtures do not establish real voice quality or latency.

Minimize features while preserving parsing, durable acknowledgement, resource cleanup, cancellation, typed errors, architectural enforcement and behavioral validation.

## User Stories

1. As the owner, I want exactly one conversation, so that I never manage chats or select which memory to use.
2. As the owner, I want to start and end voice sessions within that conversation, so that disconnecting does not discard its history.
3. As the owner, I want to send text into the same conversation, so that names, links and corrections can be entered precisely.
4. As the owner, I want to see accepted inputs and assistant output in order, so that I can understand the conversation's progress.
5. As the owner, I want temporary speech recognition to remain distinct from accepted messages, so that unstable hypotheses do not enter memory.
6. As the owner, I want a spoken interruption to stop the current answer and audio, so that the assistant yields immediately.
7. As the owner, I want a text message sent during an answer to interrupt it too, so that both input modes have consistent meaning.
8. As the owner, I want interrupted output to be marked honestly, so that generated text is not mistaken for something I heard.
9. As the owner, I want canceled output never to resume later, so that reconnects and late events do not revive an old answer.
10. As the owner, I want accepted messages to survive application and backend restarts, so that the single conversation remains durable.
11. As the owner, I want a retry to retain the same delivery identity, so that network uncertainty does not duplicate my message.
12. As the owner, I want failed text delivery to preserve my draft, so that I can retry without retyping.
13. As the owner, I want a reconnection to restore durable history, so that I can continue without replaying old audio.
14. As the owner, I want a finalized but unaccepted voice input to be distinguished from a saved message, so that loss is not concealed.
15. As the owner, I want an already active voice session to continue with the screen locked, so that I can use the phone without keeping the app visible.
16. As the owner, I want audio interruptions and route changes to leave the session in an honest recoverable state, so that a phone call or disconnected headset cannot cause stale playback.
17. As the owner, I want to use the local backend through Tailscale, so that I can try the mobile flow without public hosting.
18. As the owner, I want backend unavailability to be visible, so that a sleeping Mac is not mistaken for a thinking assistant.
19. As the owner, I want freely changing languages in a session, so that Russian, French and English do not require separate conversations.
20. As the owner, I want Japanese to fit the provider capability configuration later, so that adding it does not require redesigning the domain.
21. As the owner, I want language support checked against the selected providers, so that configuration does not advertise unsupported recognition or synthesis.
22. As the owner, I want one authoritative unii memory, so that agent frameworks do not maintain competing context.
23. As the owner, I want background compaction to remain independent of reply interruption, so that speaking over an answer does not shut down memory.
24. As the owner, I want incomplete prior memory handled explicitly, so that the assistant does not silently answer with missing context.
25. As the owner, I want memory operations bounded, so that increasing history does not create unbounded tool output or transcript reads.
26. As the owner, I want only explicitly provided memory capabilities exposed initially, so that the assistant receives no filesystem, shell or ambient integration privileges.
27. As the owner, I want to add custom tools later through a narrow capability interface, so that RAG can be added without replacing the conversation workflow.
28. As the owner, I want separate answer and summary model roles, so that Sol and Luna can later be routed through my subscription independently.
29. As the owner, I want the first prototype to work without real inference or speech API bills, so that application development is independent of model setup.
30. As an implementer, I want deterministic fake providers injected through Effect Layers, so that streaming, failure and cancellation can be tested without monkey-patching.
31. As an implementer, I want contracts grounded in inspected provider interfaces, so that a fake does not invent an impossible future integration.
32. As an implementer, I want Swift MVVM within vertical capability slices, so that presentation and domain ownership remain local and extendable.
33. As an implementer, I want explicit composition roots and resource lifetimes, so that reconnecting a phone does not leak or duplicate long-lived resources.
34. As an implementer, I want validated wire data and typed failures, so that invalid or stale events cannot corrupt the conversation.
35. As a reviewer, I want inherited architecture and TS quality checks enforced, so that the prototype's small feature set does not reduce engineering rigor.
36. As the owner, I want private source hosting and secret-scanning commit hooks, so that credentials and conversation data stay out of version control.
37. As the owner, I want real-model qualification preserved as a later task, so that deferred uncertainty remains visible without blocking the fake-provider prototype.

## Implementation Decisions

- iOS client: SwiftUI, MVVM, explicit MainActor presentation updates and strict concurrency. Organize by domain capabilities; Views and ViewModels live within their slice rather than global technical folders.
- Backend: TypeScript/Effect. Organize conversation, memory hosting, voice delivery and provider integration by their owned behavior, with a small composition root. Extract packages only for actual consumer/build/enforcement needs.
- LiveKit is the intended audio transport. Keep backend-control and media endpoints separately configurable and validate Tailscale-reachable ICE/media routes. HTTPS reachability alone is not evidence of WebRTC reachability.
- The application owns exactly one conversation. A voice session is a temporary connection, not a separate memory or conversation.
- The conversation application interface is the primary test surface: accept identified input, observe state/outcomes, interrupt and restore history. Internal lifecycle coordinates persistence, provider streams and cancellation; presentation is a projection rather than a second authority.
- unii remains plain TypeScript memory logic with injected storage and summary backend ports. Balabol owns Effect integration, adapter composition, startup/shutdown and policy about pending context. Necessary improvements to unii's memory ports are authorized, but no Effect dependency or provider SDK is added to its core.
- Durable storage is required. Select the concrete adapter during implementation against unii's existing persistence contract; SQLite is the leading local implementation option, not permission to change durability semantics.
- Storage acknowledgement must reflect its promised durable boundary. Accepted transport input and retry deduplication need a recoverable protocol even if unii stores a record before its full append receipt succeeds. Client-generated delivery identity is distinct from unii record identity.
- Use the prior-memory exclusive boundary plus the current accepted input exactly once when assembling a reply. Pending/failed previous summaries cannot be silently replaced by null context. Waiting, failure and retry behavior must be explicit and bounded; fail visibly rather than fabricate missing memory.
- One long-lived memory instance is scoped to the backend, not the phone connection. Compaction scheduling, retry policy and shutdown are coordinated by that host; phone disconnect and reply interruption do not close memory.
- The memory host owns recovery from storage fail-stop. After a transient failure, subsequent sends reconstruct unii from durable state without requiring a server restart, retaining exclusive writer ownership and delivery deduplication. Persistent failure returns a typed unavailable outcome with bounded recovery work per request; a later request can retry recovery.
- Expose bounded memory read capabilities. Transcript pagination must not repeatedly copy an unlimited journal. No RAG, filesystem, shell, generic RPC forwarding or inherited ambient tool router in the initial assistant.
- Provider roles are independent: speech recognition, phrase-based synthesis, reply generation and summarization. Initial concrete implementations are deterministic fake Layers with explicit fixture/scenario inputs and configurable scripted outcomes.
- Validate contracts at the provider/wire edges with Effect Schema; derived domain types carry validated identities, language capabilities, audio encoding/rate/channel metadata, text and typed terminal outcomes. Validate cross-field invariants, not merely object shape.
- Distinguish incoming-audio streaming from recognition of a bounded supplied audio segment, and audio-output streaming from incremental text-input synthesis. Current inspected MLX examples do not establish stateful incoming Qwen ASR or append-text TTS. Fake adapters reflect the actual supported shape, with bounded segmentation/phrase buffering where needed.
- Fakes produce format-valid fixture audio and deterministic recognition/text events and exercise empty input, partial events, completion, typed failure, cancellation and late-event rejection. Provide clock/dependencies through the application seam. They are test/development implementations, not mock replacements of imported modules.
- On speech-start or new text input, promptly invalidate the current response, stop playback and clear its queued audio, request generation/synthesis cancellation, and reject late events by response identity. Terminal interruption acknowledgement is distinct from verified remote compute cessation.
- Preserve collected generated reply text marked interrupted; it may include text not played. Convey that marker to answer context and summaries, never implying the owner heard or agreed with it. No word-level heard tracking.
- Interim STT is tentative. Commit a finalized utterance only through backend acceptance. Noise/empty interruption creates no message and does not automatically resume a canceled answer.
- Connection loss stops playback and cancels the active answer. Recovery reloads persisted conversation state and restores the session without replaying stale audio. Unaccepted speech may need repetition; accepted input is not appended again.
- Initial language set is Russian, French and English with free switching. Japanese is a future capability probe/configuration extension; real accuracy and voice quality remain unqualified. Exact language-response/voice heuristics are reversible UX choices delegated to Astra.
- Local backend availability depends on the host being awake. Configuration, credentials and data remain server-side; phone receives scoped connection access. Structure adapters so later hosting changes do not change the conversation domain.
- No real speech-engine installs, model downloads, inference calls or paid speech services now. Future answer/summary integration is subscription-only; source-validated contracts are not empirical provider qualification.
- Adopt jev's domain-first ownership, vertical slices, narrow interfaces, explicit state authority, acyclic dependencies including type-only edges and architectural reviews.
- Adopt hulymcp's generic TS/Effect boundary parsing, typed errors, functional core/imperative shell, explicit dependencies/time/configuration, Redacted secrets, immutability and cast restrictions. Do not inherit Huly-specific APIs, product workflows or patches.
- Port the complete generic TS quality harness as the first implementation prerequisite: pinned compatible Effect cohort, TS7 strict checks, Effect diagnostics, @effect/vitest, v8 Istanbul JSON feeding @crap4ts/crap4ts 1.1.0 with maximum per-function CRAP 8, no aggregate coverage percentage threshold, duplication at most 2%, production classic complexity at most 8, cycle enforcement including type-only imports, type-aware Oxlint and generic project rules, dprint Oxc TS formatting, property-test placement and full check-all. Numeric gates may not be weakened to accommodate new code.
- Repository initialization uses private GitHub hosting, pnpm, Husky/lint-staged, default-rule gitleaks with redacted output, ignore rules for secrets/private data/model weights and a tracked lockfile. Current scaffolding checks do not establish application compiler/test/CRAP acceptance.

## Testing Decisions

- Main behavioral seam: the sole conversation application interface. Compose the real unii core, a real durable storage adapter and fake provider Layers; assert accepted inputs, ordered observable events, terminal outcomes and recovered state.
- Test external behavior and contract invariants rather than private helpers, call counts or implementation structure. Higher-level assertions should survive changes to folder layout and orchestration details.
- Test interrupted speech and text, finalized versus tentative STT, empty interruption, late output, disconnect/reconnect and duplicate delivery. Assert that canceled audio cannot reappear and compaction remains alive.
- Exercise pending/failed previous summaries, summary cancellation at backend shutdown and successful retry/admission, without committing partial/failed summary output.
- Test persistence acknowledgement and failure windows, exclusive writer ownership, restart recovery and bounded history with a temporary real store. RAM-only reopen is not evidence of disk durability.
- Adapter contract tests parse valid/invalid fixture payloads, audio metadata and dependent fields; exercise partial/final/terminal sequencing and cancellation through the public adapter interface.
- Swift ViewModel tests cover intents and projections using explicit dependency seams; UI/platform checks cover start/end/mute, text input, transcript, errors and reconnect. Inspect callback isolation and audio-session ownership.
- Use deterministic clocks and concrete stub/fake implementations through dependency injection. Module mocks, spies and monkey-patching are banned.
- Prior art: unii's persistence/fail-stop/readiness/cancellation tests, slopchat's prior-memory boundary and cancellation behavior, jev's reducer/interpreter and state-authority examples, hulymcp's port-based tests and generic quality harness.
- Physical iPhone checks with fake fixture audio may qualify transport/lifecycle behavior: locked screen, long silent pause, Bluetooth changes, incoming-call interruption and network transitions. Record the actual device/build and observations. Simulator/unit success alone does not establish background audio support.
- Fake-provider latency is not real-model latency. Real language accuracy, synthesis quality, subscription access, compute cancellation and model performance are deferred; no readiness claim may conceal that boundary.
- Repository safety qualification includes safe/secret-bearing synthetic staged content, ignore-rule checks, actual commit-hook execution and clean history scanning. Never use real credentials as fixtures.

## Out of Scope

- Multiple conversations, conversation picker, multiple users/accounts, Android delivery, public cloud hosting and production release.
- New memory algorithms, replacing unii or adding competing framework memory.
- Filesystem/shell tools, external search, RAG and other custom tools in the first prototype.
- Real engine installation, weight downloads, actual Sol/Luna calls, voice-model benchmarking and paid speech services.
- Word-level tracking of heard speech, automatic replay of canceled output, elaborate memory visualizations, voice cloning and always-on recording while suspended or after force quit.
- Claims of real-provider or physical-device qualification without the corresponding experiment.

## Further Notes

The owner explicitly approved minimizing features while preserving architecture and quality. The prototype is extensible application infrastructure with deterministic providers, not proof that local engines achieve natural realtime performance.

Existing research identifies candidates and limitations; it is not product authority. A separate reminder titled “Create the real-model qualification task” must later create a bounded actual-model qualification task covering languages, streaming, warm/cold latency, cancellation, subscription capability isolation and physical mobile behavior.

Remaining local wayfinder entries preserve design detail and evidence. The owner's to-spec invocation authorizes synthesis now; implementation must settle concrete reversible adapter/storage details within this contract and record significant architectural tradeoffs without inventing completed experiments.
