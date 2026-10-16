---
status: accepted
---

# Use Yielded Agent for the conversation tool loop

Use Yielded Agent to run the bounded model/tool loop behind Answer Generation, with an injected model bridge to Balabol's existing subscription transport. The owner accepted this choice after the [runtime comparison](https://github.com/dearlordylord/balabol/issues/41). The actual published runtime accepted canonical unii context, executed explicit tools, streamed plain text and cancelled cooperative model/tool work in the tested scenarios. This avoids maintaining the entire loop ourselves and fits the existing Effect service and resource model more directly than Pi Agent Core.

## Consequences

- The product pins `@yielded/agent` version `0.1.0-beta.185` with the Effect `4.0.5` cohort, qualified by the native runtime smoke and product gates. Beta API changes are a deliberate dependency risk; keep Yielded behind the application-owned interface.
- Use the ordinary scoped runtime and `Output.text` for conversational text. A durable agent scheduler is not part of this decision. Runtime tool transcripts describe execution; unii remains canonical conversation memory, and its summarization remains independent.
- Supply only explicit knowledge tools and host context. No filesystem, shell, browser, code-execution tools, replacement memory or automatic framework compaction are enabled.
- Conversation and Voice retain response identity, stale-output fencing and playback cancellation. Personal Knowledge retains its global mutation lock, cancellation-aware commit boundary and durable operation receipts. All tested runtimes allowed a deliberately noncooperative detached handler to write after cancellation; the framework does not provide exactly-once external effects.
- Extend the existing subscription adapter for structured tool requests, results and continuation. The deterministic comparison did not qualify real subscription transport, runtime crash recovery or physical audio delivery.
- Pi Agent Core remains a viable alternative but adds AbortSignal/event adaptation and observed pre-aborted provider-call handling. Official Effect AI remains a fallback with fewer dependencies, at the cost of application-owned loop and terminal policy. Neither is selected for the first implementation.

## Stateless subscription continuation (#47)

Tool requests use `store: false` and no provider-side conversation or previous-response identifier. The adapter requests encrypted reasoning content, validates completed reasoning items against terminal output, and carries them through native Effect metadata for replay within the current answer. Partial encrypted items are never used. Reasoning is opaque execution context: it is neither canonical conversation memory nor assistant text or speech input. Each reasoning item is limited to 64 KiB, at most eight per model step, within the existing frame/body and 1.1-million-character request bounds.

Completed tool steps retain a validated ordered replay of reasoning, assistant text and function calls. The next provider request uses that order even when the native stream collected visible text before terminal metadata. Text still streams immediately; tool execution and opaque-item release wait for a validated completed model step. Provider item/call IDs correlate that protocol only. Durable knowledge operation identity remains host-owned.

Observed subscription streams can finish successfully with an empty terminal `output` array after delivering completed item events. The parser retains those validated items and their ordering for that sparse terminal form. A nonempty terminal aggregate must agree with the completed items; pending identities, missing completion events, inconsistent arguments or indexes, failed/incomplete responses and mismatched visible text remain errors. An empty aggregate never authorizes an unfinished tool call.

Provider JSON Schema must match the wire format consumed by the native tool decoder. The empty-object tool projects to an explicit empty object schema because the generic Effect export contains an unsupported `not` keyword. Other schemas retain their original record/optional-field representation; a strict-output codec that transforms records to arrays would require changing argument decoding too. Host validation remains authoritative and malformed arguments produce bounded tool errors for correction.
