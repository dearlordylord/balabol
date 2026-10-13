# Find the route to the Balabol iOS voice prototype

Labels: wayfinder:map

**Purpose:** Find the route to an extensible minimum-feature prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Active planning.
**Authority:** User-confirmed scope; candidate architecture remains a proposal until accepted.
**Expected use:** Resolve decision tickets before implementation planning.
**Lifecycle:** Maintain during wayfinding; consolidate accepted contracts into their maintained owners and delete this map and tickets after implementation handoff.

## Destination

An owner-agreed prototype contract, domain model, Swift MVVM and vertical-slice architecture, TS backend boundaries, and acceptance criteria sufficient to plan implementation without unresolved prerequisites. Implementation is a subsequent effort.

## Notes

- One enduring conversation only. Voice sessions connect to that conversation; no conversation collection or picker.
- iOS first, including live conversation with the screen locked. Swift/MVVM is the leading candidate, not a silently accepted implementation decision.
- Voice and text input share the conversation. Free switching among Russian, French and English; Japanese later through language/provider configuration.
- Backend initially runs on the user's computer, reachable through existing Tailscale; preserve a clear route to a reachable server. Cloud hosting is not an initial deliverable.
- Target local STT/TTS with no paid APIs. The initial executable prototype uses deterministic fake providers injected through Balabol Effect Layers; no real model installs, downloads, launches or inference experiments now. Production-facing interfaces must be grounded in inspected provider contracts and validated schemas, not imagined streaming capabilities.
- Fake providers must exercise partial/final recognition, streamed answer text, phrase-based synthesis and audio chunks, cancellation, late-event suppression and typed failures through the same interfaces as future real adapters. They are explicit fakes, never monkey-patched SDKs.
- Real model qualification is deferred; create the concrete experiment task after the fake-provider prototype is ready, via the recorded follow-up task.
- Model inference uses the existing Codex/ChatGPT subscription only. Sol for replies and Luna for summaries are desired; exact access and adapter contracts require evidence. Speech providers are separate.
- Existing TS memory package `@firfi/unii` in `../unii` is the sole memory authority. The user explicitly authorizes necessary changes to that package for integration; preserve its contract or record proposed contract changes explicitly. Do not introduce competing framework memory or port the Lisp implementation.
- Only memory-related capabilities initially. Custom tools such as RAG may be added later through an explicit capability interface. No filesystem/shell capabilities for the assistant.
- Minimum features, no architectural or quality shortcuts. Incorporate domain ownership, vertical capability slices, narrow interfaces, explicit state authority, acyclic source dependencies, composition roots and structural review from [jev source organization](/Users/firfi/work/typescript/jev/docs/source-organization.md).
- Adopt generic TS/Effect rules and the full reusable quality harness from [hulymcp CLAUDE.md](/Users/firfi/work/typescript/hulymcp/CLAUDE.md), [review rules](/Users/firfi/work/typescript/hulymcp/.claude/review-rules.md), and [Effect reference policy](/Users/firfi/work/typescript/hulymcp/docs/mcps/effect.md). Do not import Huly-specific behavior; define appropriate Swift checks separately. Type-only cycles also prohibited by architecture policy even where TS cycle tooling ignores them.
- UX recommendations are delegated to Astra by explicit user instruction; do not route routine UX choices back to the owner. Ask the owner domain, scope, cost and material architectural questions.
- Keep @firfi/unii as plain TypeScript memory logic, with no Effect dependency. Inject storage through its ports; add only necessary missing capabilities in ../unii. Balabol owns Effect integration, Layers and lifecycle.
- Balabol owns input delivery/retry semantics and response policy while earlier summaries are pending; memory core remains the authority for its own readiness.
- Consult wayfinder, grilling and domain-modeling each decision session; codebase-design for architecture, research for fact-finding. Existing reports in research/ are advisory, not accepted contracts; Sayna is rejected by the user.
- Tracker: local Markdown per [tracker operations](/Users/firfi/.agents/skills/setup-matt-pocock-skills/issue-tracker-local.md). Until configured otherwise, do not write to sibling projects' GitHub trackers. Optional setup: /setup-matt-pocock-skills.
- Resolved terminology: [GLOSSARY.md](../../GLOSSARY.md).

## Decisions so far

- [Subscription models: streaming, cancellation and capability restriction](issues/01-subscription-models.md): local catalog advertises Sol/Luna; successful inference, latency, cancellation and tool isolation require a bounded experiment.
- [Existing TS unii: ownership, durability and integration contract](issues/02-unii-integration.md): core is usable, but only RAM storage ships; durable storage and Luna adapters, delivery identities and context readiness need explicit decisions.
- [iOS live voice: locked screen, multilingual speech and platform evidence](issues/03-ios-voice.md): native LiveKit is viable by documentation; multilingual text turn detector covers RU/FR/EN/JA, and locked-screen/media reachability require device evidence.

- [Conversation semantics: interruption, text steering and delivered speech](issues/04-turn-semantics.md): voice/text cancel the reply; keep collected text marked interrupted, without treating it as heard; reconnect never replays stale audio.

- [Local multilingual speech: viable engines on the existing Mac](issues/11-local-speech.md): local candidates exist; inspected MLX ASR accepts supplied audio and TTS accepts complete text, so do not assume native incremental input. Real measurements deferred.

## Not yet specified

- Presentation details beyond the end-to-end interaction sketch, after lifecycle and delivery semantics settle.
- Migration and operational details beyond the initial host, after persistence and process ownership settle.

## Out of scope

- Multiple conversations, account/multi-user features, Android delivery, public cloud deployment and custom RAG tools in the first prototype.
- Replacing unii or adopting another framework's memory.
- Real model installation/inference/benchmarking in the initial prototype. [Create a task to examine real models](../followups/issues/01-create-real-model-check-task.md) records the later handoff; [Subscription qualification](issues/09-model-evidence.md) is removed from the current frontier.
- Filesystem/shell access, Sayna, and feature work during this planning map.
