# Existing TS unii: ownership, durability and integration contract

Id: 02
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:research
Type: research
Status: resolved
Assignee: /root/unii_research
Blocked by: none

**Purpose:** Find the route to an extensible minimum-feature prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Active planning.
**Authority:** User-confirmed scope; candidate architecture remains a proposal until accepted.
**Expected use:** Resolve decision tickets before implementation planning.
**Lifecycle:** Maintain during wayfinding; consolidate accepted contracts into their maintained owners and delete this map and tickets after implementation handoff.

## Question

Locate the actual @firfi/unii implementation and establish its public contract, journaling, context selection, compaction, summary backend injection, durable acceptance, cancellation and concurrency behavior. What does the agent need to own and what already belongs to memory? Cite exact sources; do not duplicate or port memory.

## Comments

## Resolution comment

Existing TS @firfi/unii is the sole memory core. It already owns journal/tree, compaction scheduling and exact context readiness. Balabol supplies durable Storage (only RAM shipped) and Luna Backend; host owns input idempotency, reply/interruption semantics and subscription admission. Long-source compression requires host step/settle; pending snapshots have no prompt; barge-in must not close memory. See [Existing @firfi/unii integration](../../../research/unii-integration.md) for source evidence and newly precise decisions.

Research context: `/tmp/balabol-unii-research-kzqpc3_s`, branch `research/unii-integration`; pinned inspected source commit `f10549bff88ee2b9db43817163f17336443bdabe`. Read-only library investigation; existing tests inspected, not rerun.
