# iOS continuous voice feasibility

**Purpose:** Evidence for the minimum Balabol voice prototype, not implementation.
**Audience:** Product owner and contributors.
**Status:** Research complete; recommendations await product decisions.
**Authority:** Primary documentation checked 2026-10-13; physical-device behavior untested.
**Expected use:** Resolve architecture and acceptance decisions in the Wayfinder map.
**Lifecycle:** Recheck SDK/provider details when dependencies are pinned.

## Finding

SwiftUI + LiveKit Swift client + Node Agents remains viable. No evidence requires replacing it with another mobile framework. Use the official [Swift starter](https://github.com/livekit-examples/agent-starter-swift) as integration evidence, not as Balabol's domain architecture. MVVM and slice boundaries belong to our application.

The [Swift SDK](https://github.com/livekit/client-sdk-swift) provides realtime audio and data, works with Cloud or self-hosted servers, uses Swift Package Manager and supports Swift 6 strict concurrency. It manages AVAudioSession automatically: playback when listening, playAndRecord when publishing microphone. Custom ownership requires disabling its automatic configuration and setting playAndRecord with voiceChat/videoChat before publishing. Its SDK callbacks are not UI-thread callbacks; project view models must explicitly hop to MainActor. Recommendation: keep default SDK audio ownership initially, with a narrow platform adapter that observes lifecycle events. Avoid two competing owners of AVAudioSession.

## Locked screen, routes and interruptions

The [Swift quickstart](https://docs.livekit.io/transport/sdk-platforms/swift/) explicitly documents continuing audio in background using UIBackgroundModes = audio. This supports an already active voice session; it is not evidence for an always-on assistant, starting recording while suspended, or surviving force quit.

Apple documents [audio route notifications](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes) and expects applications to handle headphones disappearing. Whether to continue on speaker is a product decision, especially while locked. [Audio interruption notifications](https://developer.apple.com/documentation/AVFAudio/handling-audio-interruptions) distinguish start/end and resumption eligibility. A phone call must interrupt our session: the acceptance target is recovery afterwards, never uninterrupted simultaneous recording through a system call. Current Apple docs also mark older [InterruptionOptions](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionoptions) deprecated in favour of resumption recommendation notifications; pin the deployment target before choosing APIs.

CallKit is an optional integration, not established as necessary merely for active locked-screen audio. The SDK documents separate CallKit coordination in its README. Whether native call UI is worthwhile is a later product decision.

Bluetooth duplex quality, speaker echo cancellation, silent user pauses while locked, interruption recovery and reconnection during suspension all require real-device evidence. Documentation does not guarantee our complete composition.

## Tailscale and local deployment

[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) can expose the local HTTP application using tailnet HTTPS with automatically provisioned certificates. Keep token minting, credentials and model access on the backend; phone receives a scoped room token. The local computer must remain awake and reachable.

**An HTTPS proxy is not the media path.** [LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/) separate API/WebSocket 7880 from ICE/TCP 7881 and ICE/UDP mux 7882 (or UDP port range). Inference: self-hosted LiveKit over the tailnet must advertise reachable tailnet ICE candidates and allow configured media ports; Serve alone cannot establish WebRTC media. Verify actual candidate selection and direct-versus-relayed Tailscale transport on iPhone cellular. A local application backend with LiveKit Cloud media is also possible, but hosting cost and external media processing then remain explicit decisions.

Keep application backend URL and media-server URL separate in configuration. This supports moving the backend later without redesigning conversation semantics. Migration still requires real network/TLS configuration; changing one URL is not a sufficient deployment guarantee.

## Multilingual speech candidates

| Layer          | Evidence-backed candidate            | Qualification                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming STT  | Deepgram Nova-3, language=multi      | [Model matrix](https://developers.deepgram.com/docs/models-languages-overview) includes EN/FR/RU/JA together; [GA announcement](https://deepgram.com/changelog/nova-3-multilingual-ga) explicitly claims realtime code-switching.                                     |
| TTS baseline   | ElevenLabs Flash v2.5                | [Model matrix](https://elevenlabs.io/docs/overview/models) includes EN/FR/RU/JA; realtime-oriented. [Input streaming](https://help.elevenlabs.io/hc/en-us/articles/28084327728529-What-is-the-Text-to-Speech-WebSockets-API) accepts incremental text over WebSocket. |
| TTS challenger | ElevenLabs v4 Turbo                  | Same model matrix currently recommends it for expressive realtime speech and lists all four languages, but it uses Text-to-Dialogue WebSocket; do not assume existing LiveKit TTS plugin supports that protocol/model unchanged.                                      |
| End of turn    | LiveKit text MultilingualModel + VAD | [Turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) explicitly supports EN/FR/RU/JA and depends on streaming STT language reports.                                                                                                             |

Important distinction: LiveKit's newer **audio** TurnDetector lists French/English/Japanese but **not Russian**; its older **text** MultilingualModel lists all four. Do not blindly use the newest quickstart configuration for this language set. Mixed-language end-of-turn quality and per-language reporting from the selected Node STT plugin remain experiments, not established guarantees.

[Node Agents](https://docs.livekit.io/reference/agents-js/) includes Deepgram STT and ElevenLabs TTS integrations. Free switching between configured languages does not mean supporting every possible language: configuration must be validated against recognition, synthesis and turn-detector capabilities. Same-turn mixed-language synthesis, accent, names, numbers and punctuation need listening tests. No language selector that restarts the session is required by this evidence.

## Subscription and cost boundary

Sol/Luna subscription access is independent of speech transport/providers. None of the speech documentation establishes that a ChatGPT/Codex subscription pays for these services. Paid speech APIs, LiveKit Cloud transport/inference, or local speech execution are separate decisions. No paid calls were made.

[Deepgram pricing](https://deepgram.com/pricing) currently lists Nova-3 multilingual streaming at $0.0058/min promotional pay-as-you-go, versus $0.0092/min regular; roughly $0.35/hour at the displayed current rate. Treat this as STT only, not total conversation cost. TTS, transport and cancellation waste add costs. Select a budget and provider account before any billable experiment; do not introduce paid LLM APIs as a workaround for subscription constraints.

## Smallest evidence experiment

One physical iPhone, one room, one server-generated token, microphone plus one streaming STT/TTS pair; first use deterministic text output to isolate audio from Sol latency. This is an implementation experiment to plan, not something performed in this research ticket.

1. Speak/listen/interrupt while foregrounded, then lock for 10 minutes including a long silent pause. Confirm microphone upload and remote playback remain active; unlock without a new conversation.
2. Repeat with AirPods; connect/disconnect them while locked. Record actual route and agreed fallback behavior.
3. Trigger an incoming system call, decline/accept/end, and observe interruption/recovery. Prevent stale response playback after resumption.
4. Move Wi-Fi to cellular with Tailscale enabled; briefly lose connectivity. Confirm honest reconnecting state and no duplicate committed user turns.
5. Exercise RU→FR→EN within a session and within a single utterance; add JA as a capability probe. Include numbers, names, short acknowledgements, mid-thought pauses and interruption of the agent.
6. Once transport passes, repeat with the subscription-backed Sol stream; measure user-end-to-first-audio and interruption-to-silence separately from provider latency.

Capture timestamps for VAD/STT final, turn commit, first model text, first TTS audio, interruption, route and reconnect events. The adopted minimal policy in [Conversation semantics](../.scratch/voice-prototype/issues/04-turn-semantics.md) preserves collected generated text with an interrupted outcome, explicitly without claiming delivery/hearing. Word-level playback tracking is outside the minimum prototype. Domain ownership and thresholds are decisions for their tickets.

## Research context

Parent ticket: [iOS live voice: locked screen, multilingual speech and platform evidence](../.scratch/voice-prototype/issues/03-ios-voice.md).
Isolated research branch: `research/ios-voice` in `/tmp/balabol-ios-wayfinder-research` (not a Balabol repository initialization).
