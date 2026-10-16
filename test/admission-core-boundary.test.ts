import { expect, it } from "vitest"
import core, { CoreBoundaryFailure, type OriginClock } from "../src/conversation/admission-core/index.ts"

const maximum = 281474976710655n
const clock: OriginClock = {
  $: "OriginClock",
  sourceSequence: maximum,
  currentSourceSequence: maximum,
  originRevision: maximum,
  currentRevision: maximum
}

it.each([0n, maximum])(
  "preserves the qualified bigint endpoint %s through the compiled admission path",
  (operation) => {
    const registered = core.initialize(operation, maximum, clock)
    expect(registered.operation).toBe(operation)
    expect(registered.payload).toBe(maximum)
    expect(registered.revision).toBe(maximum)
    const submitted = core.transition(registered, { $: "Submit", operation })
    expect(submitted.command).toEqual({ $: "Persist", operation, payload: maximum })
    const accepted = core.transition(submitted.state, { $: "Accepted", operation })
    const prepared = core.transition(accepted.state, { $: "PrerequisiteReady", operation })
    const started = core.transition(prepared.state, { $: "AuthorizeStart", operation })
    expect(started.command).toEqual({ $: "StartResponse", operation, payload: maximum, revision: maximum })
    expect(core.transition(started.state, { $: "Fence" }).command).toEqual({ $: "RevokeStart", operation })
  }
)

it("rejects unsupported numbers without coercion or truncation", () => {
  for (const operation of [-1n, maximum + 1n])
    expect(() => core.initialize(operation, 1n, clock)).toThrow(CoreBoundaryFailure)
  // Foreign JavaScript can bypass the generated static interface; exercise that
  // boundary without casting malformed values into valid domain types.
  for (const operation of [0, 1.5, NaN, Infinity, "1", null, undefined])
    expect(() => Reflect.apply(core.initialize, undefined, [operation, 1n, clock])).toThrow(CoreBoundaryFailure)
  expect(() => core.initialize(1n, maximum + 1n, clock)).toThrow(CoreBoundaryFailure)
  expect(() => core.initialize(1n, 1n, { ...clock, currentRevision: maximum + 1n })).toThrow(CoreBoundaryFailure)
})

it("rejects malformed admission constructors and nested fields before invoking the core", () => {
  const state = core.initialize(1n, 2n, clock)
  const malformed: readonly unknown[] = [
    { ...state, $: "Other" },
    { ...state, phase: { $: "Other" } },
    { ...state, eligibility: { $: "Other" } },
    { ...state, phase: { $: "Reserved", extra: true } },
    { ...state, operation: "1" },
    { ...state, payload: maximum + 1n },
    { ...state, revision: -1n },
    { ...state, extra: true }
  ]
  for (const input of malformed)
    expect(() => Reflect.apply(core.transition, undefined, [input, { $: "Fence" }])).toThrow(CoreBoundaryFailure)
})

it("rejects malformed event tags, operation values and excess fields", () => {
  const state = core.initialize(1n, 2n, clock)
  const malformed: readonly unknown[] = [
    { $: "Other" },
    { $: "Submit" },
    { $: "Submit", operation: "1" },
    { $: "Submit", operation: -1n },
    { $: "Submit", operation: maximum + 1n },
    { $: "Submit", operation: 1n, payload: 2n },
    { $: "Fence", operation: 1n }
  ]
  for (const event of malformed)
    expect(() => Reflect.apply(core.transition, undefined, [state, event])).toThrow(CoreBoundaryFailure)
})
