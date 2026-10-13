# Live conversational voice in TypeScript

Checked 2026-10-12. Scope: live mobile conversation, externally controlled text models and durable memory. Primary sources only.

## Recommended: LiveKit Agents for Node.js

The official Node SDK mixes STT, LLM, TTS and native realtime models, supplies semantic end-of-turn detection, MCP integration, and uses LiveKit's cross-platform WebRTC clients. The full stack can be self-hosted. It is a server-side participant, not a Cloudflare Worker library. Official Node starter includes multilingual turn detection, noise cancellation, logging and a Dockerfile. [Repository](https://github.com/livekit/agents-js), [Node starter](https://github.com/livekit-examples/agent-starter-node).

Crucially, `llmNode` can be overridden: feed the finalized utterance and selected memory into an existing agent/model backend, then yield text or chat chunks. STT and TTS nodes are also replaceable. `FlushSentinel` supports early speech segments while further work proceeds. Interrupted replies preserve completed segments and truncate the segment being played. [Pipeline hooks](https://docs.livekit.io/agents/logic/nodes/).

Turn handling includes audio turn detector, STT endpointing, VAD, realtime-model detection or manual boundaries; interruption controls and preemptive generation are configurable. These are the behaviors needed for conversational barge-in, rather than just recording audio messages. [Turn configuration](https://docs.livekit.io/reference/agents/turn-handling-options/), [turn overview](https://docs.livekit.io/agents/logic/turns/).

There is an official React Native starter for the mobile client. [Starter](https://github.com/livekit-examples/agent-starter-react-native).

Architecture recommendation (inference): React Native/Expo + LiveKit media + Node voice adapter + existing Effect conversation/memory service. Run independent summarization work on Luna, answer generation on Sol, via whatever backend actually exposes those models. Voice infrastructure does not require either model to accept audio. Keep the canonical conversation in unii, not exclusively in the voice session. Check cancellation propagation and whether saved assistant text reflects what was actually played.

## Interesting smaller option: LLMRTC

TypeScript framework with Node backend, browser WebRTC client, replaceable `LLMProvider` (`complete`, optional `stream`), STT and TTS interfaces. Documents streaming transcription and synthesis, Silero VAD, barge-in, reconnection and history persistence. Its streaming turn API accepts `AbortSignal`. Local Ollama/Faster Whisper/Piper providers are available. However the backend requires native `@roamhq/wrtc`, streaming synthesis requires FFmpeg, and deployment needs TURN configuration. The documented client is a browser client; an official native mobile SDK was not established. The repository is substantially smaller than LiveKit; assess maintenance before committing. [Repository and API](https://github.com/llmrtc/llmrtc).

This is attractive for studying an integrated TS pipeline or a personal prototype; LiveKit has the stronger documented mobile path. That comparison is an architectural judgment, not a benchmark.

## Less suitable for this exact constraint

OpenAI's TypeScript Agents voice layer wraps its Realtime API with tools, handoffs and session history. Its native speech-to-speech model is the conversational model, so it does not directly let an arbitrary text-only Sol model replace that component. A second model behind a tool is a different architecture. [Voice SDK guide](https://openai.github.io/openai-agents-js/guides/voice-agents/).

Patter is an open-source TypeScript/Python SDK centered on giving agents telephone numbers through Twilio/Telnyx/Plivo. It is a candidate for telephony, but this research did not establish a comparable mobile WebRTC client path. [Repository](https://github.com/PatterAI/Patter).

No official Effect-native integration was established for LiveKit or LLMRTC. Wrapping the voice session in an Effect service is feasible design work, not an existing vendor feature. Alchemy should provision/deploy surrounding resources; it does not by itself implement interruption, audio transport or voice turn-taking.
