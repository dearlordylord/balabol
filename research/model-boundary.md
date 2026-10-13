# Model boundary for a live voice agent

Research date: 2026-10-12. Luna and Sol are treated as user-selected models on the existing backend, not assumed public API identifiers.

- SlopChat's current adapter uses Codex app-server, per `lisp/slopchat-codex.el`, including model selection and dynamic tools. Moving the agent to TypeScript does not make that backend an ordinary OpenAI-compatible chat endpoint; it needs a streaming/cancellation adapter.
- Official app-server docs describe experimental dynamic tools and streamed events. Model availability must be verified by a successful call, not merely inclusion in a catalog. [App-server](https://learn.chatgpt.com/docs/app-server), [ChatGPT-plan configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
- The documented ChatGPT-plan token-sharing flow does not provide audio/video input or the transcription API. STT and TTS need separately selected providers. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
- Speech-to-speech uses a Realtime model; arbitrary text models are not direct replacements for that audio model. For Sol-authored spoken answers, a streaming STT -> text model -> TTS pipeline preserves model choice. [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).

Recommended application contract: independent response and summary model services; streaming response deltas plus cancellation; application-owned allowlisted tools; durable memory independent of audio sessions. File/shell access must be excluded at the actual provider/process boundary, not just by a prompt. How best to disable built-in app-server tools still requires implementation-specific verification.

On interruption, stop queued playback and generation, distinguish generated text from delivered speech, and retain interrupted output honestly in the journal. Persist conversation input before exposing acceptance; compact asynchronously with Luna rather than adding it to the time-to-first-audio path. These are design recommendations, not measured latency claims.
