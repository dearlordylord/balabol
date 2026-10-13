# iOS live voice: locked screen, multilingual speech and platform evidence

Id: 03
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:research
Type: research
Status: resolved
Assignee: /root/ios_research
Blocked by: none

**Purpose:** Find the route to an extensible minimum-feature prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Active planning.
**Authority:** User-confirmed scope; candidate architecture remains a proposal until accepted.
**Expected use:** Resolve decision tickets before implementation planning.
**Lifecycle:** Maintain during wayfinding; consolidate accepted contracts into their maintained owners and delete this map and tickets after implementation handoff.

## Question

Determine the viable Swift/LiveKit voice path for live duplex conversation under locked screen, Bluetooth, system interruptions and Tailscale-accessible local backend. Compare narrow alternatives only if evidence requires them. Establish provider support for Russian/French/English and future Japanese, including mixed-language recognition and turn detection. Separate documented claims from behavior requiring a physical-device experiment. Recommend the smallest evidence experiment and explicit speech cost boundary.

## Comments

### Resolution — 2026-10-13

Swift/LiveKit supports active background audio via the documented iOS audio mode; real-device locking, route changes, interruption recovery and reconnect behavior remain mandatory evidence experiments. Tailscale Serve covers HTTPS application access, not LiveKit's separate ICE media ports. Deepgram Nova-3 multilingual explicitly supports realtime switching across RU/FR/EN/JA; ElevenLabs Flash v2.5 is the documented low-latency TTS baseline. LiveKit's text MultilingualModel supports all four, whereas its newer audio detector omits Russian. Speech billing is separate from subscription-backed Sol/Luna and has not been authorized or exercised. These are feasibility facts and recommendations, not acceptance of a provider or deployment choice.

Evidence and smallest proposed device experiment: [iOS continuous voice feasibility](../../../research/ios-voice-feasibility.md).
Research context: isolated `/tmp/balabol-ios-wayfinder-research`, branch `research/ios-voice`; no Balabol git initialization or implementation.
