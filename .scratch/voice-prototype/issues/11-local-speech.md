# Local multilingual speech: viable engines on the existing Mac

Id: 11
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:research
Type: research
Status: closed
Assignee: /root/local_speech
Blocked by: 03

**Purpose:** Establish local STT/TTS candidates without paid speech APIs.
**Audience:** Product owner and contributors.
**Status:** Research evidence collected; engine choice remains open.
**Authority:** Advisory evidence; provider selection remains a decision.
**Expected use:** Unblock Language policy and speech-provider selection.
**Lifecycle:** Consolidate accepted choices into contracts at implementation handoff.

## Question

On the current Apple M2 Max with 96 GiB RAM, what locally runnable STT/TTS engines support RU/FR/EN and future JA, free code switching, incremental audio and interruptible delivery? Compare Qwen3-ASR/TTS on MLX, whisper.cpp and native Apple synthesis. Distinguish audio-output streaming from true incremental text-input synthesis, and windowed recognition from native streaming. Establish integration/cancellation/model lifecycle and licensing from primary sources, not unmeasured speed claims. No paid APIs, installs or large model downloads in research.

## Comments

### Resolution — 2026-10-13

Local speech avoids paid STT/TTS APIs. Evaluate Qwen3-ASR/TTS small models on MLX; compare whisper.cpp STT and optional Apple synth. Required languages are supported, but free code switching, Mac latency and interruption remain experiments. Crucially MLX ASR text streaming is not verified incoming-audio stateful streaming, and MLX Qwen TTS streams output for complete text rather than a verified append-text API.

Evidence: [Local multilingual speech](../../../research/local-speech.md). Research snapshot branch: `research/local-speech` in the isolated temporary repository recorded below. No installation, weights download or paid calls.

Snapshot repository: `/var/folders/kv/bn6b4b8d5238dqw8m7_t7dk40000gn/T/balabol-local-speech-gexd17l7`.
