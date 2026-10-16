---
status: accepted
---

# Store evolving personal knowledge in a SQLite-backed module

Balabol will expose a personal knowledge module with its own interface, backed by SQLite and integrated through Effect. The agent can evolve an explicit domain schema stored as data; the module validates entities and relations, serializes mutations under one global lock, and retains accepted schema and data changes together. This supports one agent and an empty initial database without requiring a separate database service.

The disposable SQLite and TerminusDB experiments demonstrated schema evolution and historical reads. TerminusDB supplied native migrations and history, but the tested endpoint-kind constraint still required application enforcement. SQLite fits the existing runtime; we accept responsibility for domain validation, migrations and retained history. Dolt was researched but not executed. Evidence and the canonical decision are in [Choose the knowledge module architecture and initial scope](https://github.com/dearlordylord/balabol/issues/39), linked to the [comparison](https://github.com/dearlordylord/balabol/issues/38).

## Consequences

- The first product slice exposes validated tools during the existing conversation: create types, entities and relations; retrieve and use them in replies or exercises; apply simple schema migrations; retain schema, data and history across restart. Programmatic schema/history inspection supports debugging.
- Conversation memory continues to own the conversation and free-form observations. The knowledge module has no generic note fallback. unii remains plain TypeScript memory logic; this feature does not add a second conversation-memory system.
- Failed changes publish no partial state. Accepted changes preserve their matching schema and data. The experiment used complete snapshots as a correctness reference; production history encoding, indexing and growth limits must be specified and qualified rather than inferred from a tiny fixture.
- Import, dictionary enrichment, graphical editing, automatic review scheduling, entity splitting/merging and selective correction after later edits are deferred. The initial agent can use retrieved knowledge in conversation without an embedded scheduler.
- The initial schema dialect, bounded operations and cancellation/durability rules are described below. Relations and migration behavior remain subsequent implementation slices. Ajv was used in the experiment; this ADR does not select it as a production dependency. Effect Schema owns I/O contracts.

## First durable slice (#44)

The module stores a complete schema/entity snapshot for every accepted revision, including the empty revision zero. The same SQLite transaction advances the current snapshot, inserts the immutable historical snapshot and records the accepted input/tool-operation identity, response provenance and reason. The host derives conversational operation identity from SHA-256 of the canonical decoded change, namespaced by accepted input identity; provider call IDs are protocol correlation only. Identical changes within one accepted input are one operation. Changed reasons, entity IDs or other payload represent different operations; this is payload deduplication, not semantic intent matching. A repeated operation returns its original receipt; conflicting explicit identity reuse at the module boundary is rejected. Response identity is provenance, so retrying an accepted input with a new response does not create another revision. History has no revision-count cap or silent pruning. Full snapshots deliberately trade disk growth for direct reconstruction; storage failures return `KnowledgeUnavailable` rather than discarding history.

`PersonalKnowledge` owns a single mutation semaphore. Inference runs outside it. The adapter borrows the composition's leased WAL/FULL SQLite resource, and synchronous transactions have no asynchronous cancellation point. Cancellation before commit publishes nothing; cancellation after commit can lose acknowledgement while preserving the receipt. A retry receives accepted-operation receipts before inference and can page through them. Programmatic revision inspection reads an indexed historical snapshot without replaying model calls.

The initial dialect has named types with required/optional string, finite-number and boolean fields. Create assigns a supplied stable UUID; update replaces its complete values while preserving identity and type. Text equality does not merge entities. Relations and schema migrations arrive in subsequent slices; there is no delete or untyped fallback.

Contracts in `src/personal-knowledge/models.ts` bound a change to 100 entries and 128 KiB UTF-8, a snapshot to 10,000 entities and 4 MiB, a schema to 64 types with 32 fields each, and scalar strings to 4,096 characters. Queries return at most 100 entities and 256 KiB including the schema; receipt pages return at most 20 operations and 256 KiB. Names are at most 128 characters, reasons 1,024 and operation identities 256. Limits apply together: a legal large snapshot may require smaller query pages, and schema metadata alone can make a query exceed its byte budget. That returns actionable `LimitExceeded`; it never truncates a value. These are finite prototype envelopes, not a throughput or unlimited-disk claim.
