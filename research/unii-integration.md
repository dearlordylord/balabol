# Existing @firfi/unii integration

Research date: 2026-10-13. Primary evidence: clean local checkout `/Users/firfi/work/typescript/unii`, commit `f10549bff88ee2b9db43817163f17336443bdabe`. No library changes or new tests were needed for this read-only investigation.

## Result

Use the existing TS package as the single memory core. It already owns the immutable journal/tree, summary scheduling and retries, main/compaction contexts and readiness. It intentionally delegates durable storage and model calls to the host. Balabol must supply a durable Storage adapter and a Luna Backend adapter; these are integration responsibilities, not a replacement memory implementation. [Normative contract](/Users/firfi/work/typescript/unii/spec/MEMORY.md), [boundaries](/Users/firfi/work/typescript/unii/docs/BOUNDARIES.md).

## Public API and dependency

`Memory`, `InMemoryStorage`, and public types are exported; internal tree primitives are not. Package `@firfi/unii` version 0.1.0 is ESM, requires Node >=22, has no production dependencies. README says this version is prepared but not yet published; do not assume registry availability. Pin the local source commit/package tarball initially, then decide distribution for server deployment. No AGENTS.md or CLAUDE.md exists inside this checkout; normative standards are its spec and boundary docs. [exports](/Users/firfi/work/typescript/unii/src/index.ts), [package](/Users/firfi/work/typescript/unii/package.json), [installation](/Users/firfi/work/typescript/unii/README.md).

`Memory.open({storage, backend, policy, validate})`; append returns `{firstId, ids, endExclusive}`; snapshot accepts exclusive `before` and `main|compaction` view; retrieval is `records()`, `nodes()`, `zoom(first,count,{page})`, `date(id)`. Records carry arbitrary string kinds, text, sequential IDs and timestamp. This is not a semantic/RAG search API. `records()` copies the entire journal: bounded transcript pagination belongs in the host persistence/query adapter rather than repeatedly copying unlimited history. [types](/Users/firfi/work/typescript/unii/src/types.ts), [implementation](/Users/firfi/work/typescript/unii/src/memory.ts).

## Durability and concurrency

Storage supplies `open/load/appendRecords/appendNode/checkpoint/close`. Exclusive writer acquisition, atomic record batches, atomic checkpoint replacement, persistence acknowledgement and recovery of a valid prefix after interruption belong to the adapter. The shipped adapter is RAM only; reopening the same instance is not process-restart durability. No disk/SQLite adapter is shipped. [storage contract](/Users/firfi/work/typescript/unii/spec/MEMORY.md), [RAM adapter](/Users/firfi/work/typescript/unii/src/storage.ts).

Core mutations are serialized via its private promise tail. It waits for appendRecords persistence before publishing the journal and returning a receipt; append additionally creates verbatim short nodes before resolving. If that later stage fails, raw records may already be persisted without a returned receipt. Any storage failure puts the open instance in a fail-stop state. Consequently transport acknowledgement/deduplication and user-message delivery identities require a host protocol; unii is not exactly-once message delivery. Its record IDs are storage identities, not client idempotency keys. [append/persist](/Users/firfi/work/typescript/unii/src/memory.ts), [persistence tests](/Users/firfi/work/typescript/unii/test/memory.test.ts:36).

`Memory.open` validates recovered images and rebuilds missing short/verbatim nodes without calling the backend. Host must subsequently call `step()` to admit long-source compression or `settle()` to wait for currently schedulable work. No independent timer exists. Default compression admission is eight jobs, five attempts; failed nodes are eligible again after a new append. Defaults are configurable and must be tuned to subscription transport limits rather than inherited blindly. [scheduler](/Users/firfi/work/typescript/unii/src/memory.ts), [normative compression contract](/Users/firfi/work/typescript/unii/spec/MEMORY.md).

## Luna injection and prompt authority

Backend receives `{source, context, node, jobId, attemptId, attempt, priorResponses, feedback}`, `AbortSignal`, observation emitter; returns `Promise<string>`. Host supplies Luna routing/authentication/prompt/provider stream consumption and optional source-validation policy. `source` is the immutable authoritative material; earlier `context` is supporting context, not material to copy into the summary. Short source <=512 UTF-8 bytes by default avoids LLM inference. After bounded size retries the shortest valid complete response can exceed the target. Runtime diagnostics and usage are not persisted, payload retention is count-bounded but not byte-bounded. [Backend type](/Users/firfi/work/typescript/unii/src/types.ts), [compression contract](/Users/firfi/work/typescript/unii/spec/MEMORY.md).

Slopchat already separates these concerns: its memory-policy file implements attribution/source-envelope prompts and its backend file uses the subscription transport. These Lisp policies are design evidence for a TS adapter, not an instruction to port the memory core. [policy](/Users/firfi/work/formal-proofs/slopchat/lisp/slopchat-memory-policy.el), [backend](/Users/firfi/work/formal-proofs/slopchat/lisp/slopchat-memory-backend.el).

## Context boundary and real-time behavior

Pending/failed snapshots have `text:null`; they are unusable prompt contexts. Completed later leaves cannot bridge a missing earlier leaf. Exact exclusive boundaries can avoid blocking on compression of the current message: append accepted input, get `snapshot({before:receipt.firstId})`, then add current input separately. Slopchat does precisely this, and queues turns while prior memory is pending. This avoids duplicating the current input and usually keeps current-message compression off the response path, but earlier unfinished summaries can still block. Do not promise entirely latency-free background summarization. [snapshot implementation](/Users/firfi/work/typescript/unii/src/memory.ts), [ready/pending tests](/Users/firfi/work/typescript/unii/test/memory.test.ts:26), [slopchat prompt boundary](/Users/firfi/work/formal-proofs/slopchat/lisp/slopchat.el:174).

Cancellation is memory-instance scoped: `close()` aborts all summary jobs, drains queued storage, releases storage, ignores late completions. There is no public per-job cancellation. Barge-in should cancel Sol/TTS delivery, not close the conversation's long-lived memory. Summary background work continues across voice-session disconnects. [close](/Users/firfi/work/typescript/unii/src/memory.ts), [late completion test](/Users/firfi/work/typescript/unii/test/memory.test.ts:31).

## Ownership proposal for decision tickets

- Memory core: tree, compaction, snapshot readiness, summary retries, diagnostics.
- Memory host capability: owns one long-lived Memory instance, durable Storage adapter, Luna Backend, pump lifecycle, memory retrieval tools. Effect scope closes it on server shutdown, not on phone disconnect.
- Conversation capability: accepted input/outcome records, idempotency and causal ordering, single conversation, serialized reply policy, assembled prompt boundary, interrupted-answer recording policy.
- Voice capability: tentative/final transcript distinction, user endpoint detection, generated/spoken/delivered text distinction, barge-in and playback acknowledgements. Never journal each partial STT hypothesis as an accepted user message.
- Provider capability: subscription-only Sol/Luna auth/model routing, streaming and cancellation, shared admission policy. No filesystem/shell tools granted to either agent.

These are proposed responsibility boundaries, not user-approved architecture decisions.

## Open decisions made precise by evidence

1. Durable Storage: SQLite versus another adapter, promised persistence boundary and exclusive writer locking; restart/crash evidence required.
2. Reply context policy: exact prior ready snapshot, explicit handling of pending/failed prior summaries and budget policy.
3. Accepted-event protocol: client idempotency keys, atomicity between transport acknowledgement and unii append, interrupted/generated-versus-spoken answer persistence.
4. Memory tools: which bounded wrappers around zoom/date/history the model can invoke; RAG is a future tool, not present functionality.
5. Package distribution: pin local tarball/commit now versus publishing the package before remote hosting.
6. Summary admission and shutdown: subscription concurrency limit, configurable default 8, orderly shutdown versus immediate close.

## Evidence limits

Unit tests cover storage confirmation/fail-stop, exclusive ownership, cancellation, copied reads, bounded concurrency, snapshot gaps and corruption. Property/Lisp oracle checks cover deterministic behavior, not every completion order, semantic summary quality or durable disk recovery. Existing tests were inspected, not rerun; no changed implementation exists. [test source](/Users/firfi/work/typescript/unii/test/memory.test.ts), [validation limits](/Users/firfi/work/typescript/unii/docs/BOUNDARIES.md).
