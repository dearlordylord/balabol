# Rust voice candidates

Checked 2026-10-12 against upstream sources. Recommendations below are architectural judgments, not benchmarks.

## Best match to a separate Effect agent: Sayna

[Sayna](https://github.com/SaynaAI/sayna) is a Rust voice-processing service, not an agent framework. It exposes bidirectional WebSocket STT/TTS and integrates with LiveKit WebRTC rooms. Providers include Deepgram, ElevenLabs, Google and Azure. Optional features provide Silero VAD, ONNX end-of-turn detection and DeepFilterNet noise suppression. Apache-2.0.

Its [WebSocket protocol](https://github.com/SaynaAI/sayna/blob/master/docs/websocket.md) has transcription events, queued `speak`, `allow_interruption`, and `clear` to stop playback. A separate Effect backend can therefore receive transcripts, call any streaming text model, retrieve unii context, and feed text to speech. Summarization can use an independent model. This is an inference from the protocol, not a shipped Effect integration. Cancellation of generation, heard-versus-generated transcript consistency, reconnects and tool permissions remain application responsibilities. Docs contain stale inconsistencies (e.g. auth/credentials), so validate against source before adoption.

Mobile route: use LiveKit client SDKs; Sayna itself does not supply a complete mobile app. Worth a prototype if Rust is desired specifically for the voice service.

Russian support depends on the selected STT/TTS provider and model, not Rust or Sayna; evaluate recognition, speech output and turn detection separately in Russian.

## Interesting self-hosted option: Kyutai Unmute

[Unmute](https://github.com/kyutai-labs/unmute) streams browser audio through STT → external text LLM → TTS; the upstream README explicitly says any LLM can be used. Production uses OpenRouter; self-hosted vLLM is supported. Unlike Moshi, this preserves freedom to choose the answering model. Memory/summarization would be supplied by our adapter.

Rust processes serve STT/TTS, but orchestration is Python and the browser frontend is separate. Supported local deployment is Linux/WSL, CUDA, x86_64 and at least 16GB VRAM; Mac is unsupported for this complete app. It is a GPU deployment project, not a small TS dependency. Most interesting if owning speech inference is itself a goal. Russian speech quality/support must be checked separately; do not assume it from the demo.

The [upstream Kyutai speech model list](https://github.com/kyutai-labs/delayed-streams-modeling) currently advertises STT models `stt-1b-en_fr` (English/French) and `stt-2.6b-en` (English). This is a significant obstacle for a Russian-first assistant without replacing speech models.

## More complete Rust stack, telephony focus: active-call

[active-call](https://github.com/miuda-ai/active-call) is a Rust SIP/WebRTC voice agent server with a built-in web client and WebSocket/WebRTC APIs. Supports both ASR → LLM → TTS and realtime model pipelines, configurable VAD/ASR interruptions, noise suppression and audio fade-out. It has external webhook handlers and configurable providers. Current product shape is stateful Markdown playbooks, scenes, transfer, recording and call management.

Potentially useful for a Rust-only media server, but more telephony machinery than this personal mobile-memory assistant needs. Independent summary model belongs in our backend. Verify custom LLM endpoint and streamed webhook semantics against code before committing to an adapter; README alone does not prove arbitrary external agent integration.

## Experimental mobile/local option: Pipecrab

[Pipecrab](https://github.com/SheaHawkins/pipecrab) builds composable Rust voice pipelines. Upstream claims local inference on macOS/iOS/Android and wasm; browser engines use JS under common capability traits. It includes a barge-in example and integrations with external Hermes/ZeroClaw agent daemons. MIT.

Early project: cloud LLM offload integrations (Vertex/OpenRouter) are on its roadmap. Treat mobile claims as upstream-reported, not independently validated. Interesting design inspiration for local-first/edge, but not the safest route to streaming hosted Sol responses today.

## Distinguish models from transport/framework

[Moshi](https://github.com/kyutai-labs/moshi) has Rust/Candle inference and full-duplex speech-text modeling. [PersonaPlex](https://github.com/NVIDIA/personaplex) adds text persona/role and audio voice conditioning, but its official server is Python/PyTorch. Both produce answers inside their speech model. Replacing that brain with an arbitrary text Sol model is not an advertised plug-in operation; a separate summarizer remains possible, but does not satisfy choosing the answering model. Unmute is the relevant Kyutai project for that requirement.

[LiveKit Rust SDK](https://github.com/livekit/rust-sdks) provides realtime media/client and server APIs. Upstream explicitly directs voice-agent builders to its Python or Node.js Agents SDK. A Rust SDK should not be mistaken for parity with Node Agents' conversation orchestration.

Recommendation: production-oriented TS project should still compare LiveKit Node Agents first. Rust experiment shortlist: **Sayna + Effect agent + unii**; GPU-owning alternative: **Unmute + agent adapter**. Keep summarization off the audio response critical path, and on interruption persist what was actually heard rather than blindly recording the entire generated answer.
