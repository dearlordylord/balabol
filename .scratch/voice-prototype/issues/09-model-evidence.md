# Subscription adapter qualification: actual inference and restricted capabilities

Id: 09
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:task
Type: task
Mode: AFK
Status: resolved
Assignee: unassigned
Blocked by: 01

**Purpose:** Resolve a prerequisite of the minimum voice prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Open decision ticket.
**Authority:** Wayfinder planning; proposals require resolution.
**Expected use:** Resolve before dependent architecture is accepted.
**Lifecycle:** Consolidate into maintained contracts and delete at implementation handoff.

## Question

What bounded local experiment establishes successful Sol/Luna inference through the existing subscription, first-delta timing, terminal cancellation and exclusion of filesystem/shell/MCP tools on the pinned CLI? Record sanitized evidence; no credential export or API-key fallback. Choose an isolation approach before testing restricted capabilities. This produces evidence for the adapter decision, not a production implementation.

## Comments

## Scope closure

Owner explicitly deferred all real-model experiments on 2026-10-13. No experiment performed and no compatibility/performance claim accepted. Removed as a prerequisite of the fake-provider prototype; follow-up: [Create a task to examine real models](../../followups/issues/01-create-real-model-check-task.md).
