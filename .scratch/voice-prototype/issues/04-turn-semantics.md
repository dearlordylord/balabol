# Conversation semantics: interruption, text steering and delivered speech

Id: 04
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:grilling
Type: grilling
Status: resolved
Assignee: /root
Blocked by: 01, 02

**Purpose:** Find the route to an extensible minimum-feature prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Active planning.
**Authority:** User-confirmed scope; candidate architecture remains a proposal until accepted.
**Expected use:** Resolve decision tickets before implementation planning.
**Lifecycle:** Maintain during wayfinding; consolidate accepted contracts into their maintained owners and delete this map and tickets after implementation handoff.

## Question

Agree the behavior when the user interrupts, sends text during speech, disconnects, retries, or reconnects after restart. What counts as accepted input, an assistant reply and speech actually heard? Which records remain in memory, and who owns turn/session state? Resolve with concrete scenarios; distinguish generated, persisted and played content.

## Comments

### Owner steering — 2026-10-13

- Speaking over the assistant cancels current generation and playback; text sent during a reply does the same.
- Keep interrupted-response recording maximally simple. UX recommendation delegated to Astra; no owner approval inferred for unresolved domain semantics.
- Balabol owns repeat-delivery and prior-summary waiting policies; settle them in Durable memory host.

## Answer

Owner-approved: voice and text interrupt the active reply. Owner requested maximum simplicity and delegated UX recommendations to Astra. The following minimal contract adopts that recommendation.

- On interruption stop generation and playback, discard queued audio and ignore late events from the superseded response.
- Persist the reply text already collected by the backend with an interrupted outcome. This is generated text, not evidence of delivered or heard speech; it may include text never played. Propagate that distinction into Sol context and Luna summaries. No word-level playback accounting.
- Interim STT is tentative presentation only. Finalized speech and text become conversation input only after backend acceptance.
- Empty/noise interruption creates no new input and does not automatically resume the previous reply.
- On connection loss stop playback and cancel the current response. Reconnect reloads durable history and restores listening, without replaying old audio.
- Delivery identities, retry deduplication, persistence acknowledgement and prior-summary readiness policy remain Balabol responsibilities, settled in Durable memory host. Accepted input survives reconnect/restart; unaccepted speech may need repetition.
- A voice-session cancellation does not close the long-lived memory instance or cancel unrelated Luna compaction.

This resolves observable turn semantics. Concrete domain types, durable transaction design and ownership enforcement belong to the architecture/memory tickets. Source: Astra consultation in this session; owner responses recorded above.
