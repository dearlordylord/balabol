# Создать таск проверки реальных моделей

Id: followup-01
Type: task
Status: open
Assignee: unassigned
Activation: after the fake-provider prototype is ready and the owner resumes real-provider integration

**Purpose:** Preserve explicitly deferred real-model qualification work.
**Audience:** Product owner and contributors.
**Authority:** Owner instruction on 2026-10-13; this ticket does not authorize installs or inference now.
**Expected use:** Create a concrete bounded qualification task at activation, rather than run experiments from this reminder.
**Lifecycle:** Close when the executable qualification task exists; link it here and transfer all still-applicable checks.

## Question

Create a task to inspect and qualify real local speech engines and subscription-backed answer/summary models against the prototype's validated adapter interfaces.

The created task must carry:

- Exact model/runtime versions and selected local engines, actual Sol/Luna access through subscription only; no paid fallback.
- STT RU/FR/EN and future JA, within-utterance language changes, finalization and dropped/duplicated words.
- Local Qwen MLX versus whisper.cpp evidence; distinguish recognition over supplied audio from incoming-audio streaming.
- Phrase-fed synthesis versus true incremental text input, RU/FR voice quality and first audio.
- First-text/first-audio delay, warm/cold startup, sustained realtime speed and memory use on the existing Mac.
- Cancellation, compute release, late-event rejection and reconnect; terminal success distinct from partial output.
- Actual filesystem/shell/MCP exclusion for the subscription adapter.
- Physical iPhone locked-screen audio, Bluetooth, interruptions, Tailscale media reachability and network transitions.
- Record results separately from fake-provider conformance; update contracts only through explicit evidence-backed decisions.

## Context

[Wayfinder map](../../voice-prototype/map.md), research/local-speech.md, research/subscription-model-integration.md, research/ios-voice-feasibility.md.
