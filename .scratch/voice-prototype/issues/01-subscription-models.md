# Subscription models: streaming, cancellation and capability restriction

Id: 01
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:research
Type: research
Status: resolved
Assignee: /root/subscription_research
Blocked by: none

**Purpose:** Find the route to an extensible minimum-feature prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Active planning.
**Authority:** User-confirmed scope; candidate architecture remains a proposal until accepted.
**Expected use:** Resolve decision tickets before implementation planning.
**Lifecycle:** Maintain during wayfinding; consolidate accepted contracts into their maintained owners and delete this map and tickets after implementation handoff.

## Question

Which supported subscription-backed interface exposes the user's actual Sol/Luna models, streaming responses, summarization, and cancellation while excluding filesystem/shell tools? Establish exact local backend/version evidence, authentication/resource lifecycle, and what cannot be inferred from a catalog. Do not substitute API-key inference or assume model aliases are public API names.

## Comments

## Answer

Research completed: owned Codex app-server is the locally evidenced subscription-only candidate; exact local catalog advertises gpt-6.1-sol and gpt-6-luna. Entitlements, latency, cancellation and capability exclusion require an acceptance spike, not catalog inference. Existing slopchat flags cannot alone establish no-filesystem access. App-specific SIWC/direct Responses is a documented alternative with separate authorization lifecycle. Audio providers remain separate.

Evidence: [Subscription model integration](../../../research/subscription-model-integration.md).

Research context: isolated temporary git repository `/tmp/balabol-subscription-research-mq0ty7u8`, branch `research/subscription-models`; report copy retained there. Balabol was not initialized or committed.
