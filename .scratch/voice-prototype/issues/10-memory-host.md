# Durable memory host: storage, context readiness and unii changes

Id: 10
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:grilling
Type: grilling
Mode: HITL
Status: open
Assignee: unassigned
Blocked by: 02

**Purpose:** Resolve a prerequisite of the minimum voice prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Open decision ticket.
**Authority:** Wayfinder planning; proposals require resolution.
**Expected use:** Resolve before dependent architecture is accepted.
**Lifecycle:** Consolidate into maintained contracts and delete at implementation handoff.

## Question

Choose durable storage and recovery/acknowledgement guarantees, client deduplication, bounded history, prior-context pending/failure policy, summary admission, package distribution and orderly shutdown. Keep unii dependency-free plain TypeScript memory logic; its Storage/Backend ports inject storage and summarization. Add only capabilities missing for those responsibilities. Balabol implements the Effect integration and Layer acquisition/release/cancellation; do not add Effect to unii. Balabol owns delivery deduplication and the policy for pending summaries. Which responsibilities belong to Balabol adapters and which necessary changes belong in ../unii? User authorizes changing unii; no replacement memory. Tie proposed changes to its current contract and keep one authority for memory state.

## Comments
