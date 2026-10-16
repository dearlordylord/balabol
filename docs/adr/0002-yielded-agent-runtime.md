---
status: accepted
---

# Use Yielded Agent for the conversation tool loop

Use Yielded Agent to run the bounded model/tool loop behind Answer Generation, with an injected model bridge to Balabol's existing subscription transport. The owner accepted this choice after the [runtime comparison](https://github.com/dearlordylord/balabol/issues/41). The actual published runtime accepted canonical unii context, executed explicit tools, streamed plain text and cancelled cooperative model/tool work in the tested scenarios. This avoids maintaining the entire loop ourselves and fits the existing Effect service and resource model more directly than Pi Agent Core.

## Consequences

- The experiment used `@yielded/agent` version `0.1.0-beta.185` with Effect `4.0.5`; the compatibility task pins that complete cohort in the product before runtime integration. Beta API changes are a deliberate dependency risk; keep Yielded behind the application-owned interface.
- Use the ordinary scoped runtime and `Output.text` for conversational text. A durable agent scheduler is not part of this decision. Runtime tool transcripts describe execution; unii remains canonical conversation memory, and its summarization remains independent.
- Supply only explicit knowledge tools and host context. No filesystem, shell, browser, code-execution tools, replacement memory or automatic framework compaction are enabled.
- Conversation and Voice retain response identity, stale-output fencing and playback cancellation. Personal Knowledge retains its global mutation lock, cancellation-aware commit boundary and durable operation receipts. All tested runtimes allowed a deliberately noncooperative detached handler to write after cancellation; the framework does not provide exactly-once external effects.
- Extend the existing subscription adapter for structured tool requests, results and continuation. The deterministic comparison did not qualify real subscription transport, runtime crash recovery or physical audio delivery.
- Pi Agent Core remains a viable alternative but adds AbortSignal/event adaptation and observed pre-aborted provider-call handling. Official Effect AI remains a fallback with fewer dependencies, at the cost of application-owned loop and terminal policy. Neither is selected for the first implementation.
