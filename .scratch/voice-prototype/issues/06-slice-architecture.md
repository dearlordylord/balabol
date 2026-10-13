# Prototype architecture: Swift MVVM, vertical slices and domain authority

Id: 06
Parent: [Find the route to the Balabol iOS voice prototype](../map.md)
Labels: wayfinder:grilling
Type: grilling
Status: open
Assignee: unassigned
Blocked by: 01, 02, 03, 04, 05, 10

**Purpose:** Find the route to an extensible minimum-feature prototype.
**Audience:** Product owner and contributors, including coding agents.
**Status:** Active planning.
**Authority:** User-confirmed scope; candidate architecture remains a proposal until accepted.
**Expected use:** Resolve decision tickets before implementation planning.
**Lifecycle:** Maintain during wayfinding; consolidate accepted contracts into their maintained owners and delete this map and tickets after implementation handoff.

## Question

Agree domain owners, slice boundaries, cross-process contracts, authoritative state, MVVM responsibilities, concrete infrastructure adapters, composition roots, resource lifetimes and dependency enforcement. Choose client stack explicitly. Apply jev architecture principles and hulymcp TS standards without importing product-specific rules or mechanically translating TS tooling to Swift. Preserve a narrow later custom-tool seam and a host migration boundary.

## Comments

### Owner steering — 2026-10-13

Initial prototype uses fake local-speech and answer/summary providers through Effect Layers with source-grounded, schema-validated interfaces. No real model installation or execution now. Scope includes behavioral conformance of fakes and faithful cancellation/terminal outcomes; empirical real-provider performance is deferred. Core unii stays plain TypeScript.
