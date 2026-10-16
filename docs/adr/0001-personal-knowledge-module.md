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
- The schema dialect, bounded tool operations and production cancellation/durability behavior remain specification and implementation work. Ajv was used in the experiment; this ADR does not select it as a production dependency. Effect Schema continues to own I/O contracts.
