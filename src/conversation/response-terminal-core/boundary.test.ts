import { expect, it } from "vitest"
import core, { TerminalCoreBoundaryFailure, type Intent } from "./index.ts"

const maximum = 281474976710655n
const intent: Intent = { $: "Intent", operation: maximum, payload: maximum, outcome: { $: "Interrupted" } }

it("preserves qualified token endpoints through real selection, retry and durable acknowledgement", () => {
  const selected = core.transition(core.initialize(maximum), { $: "Select", attempt: maximum, intent, invocation: 0n })
  expect(selected.command).toEqual({ $: "Persist", attempt: maximum, intent, invocation: 0n })
  const failed = core.transition(selected.state, {
    $: "StorageFailed",
    attempt: maximum,
    operation: maximum,
    invocation: 0n
  })
  const retrying = core.transition(failed.state, {
    $: "RetryPersistence",
    attempt: maximum,
    operation: maximum,
    invocation: maximum
  })
  expect(retrying.command).toEqual({ $: "Persist", attempt: maximum, intent, invocation: maximum })
  const stored = core.transition(retrying.state, { $: "StoredAck", attempt: maximum, intent })
  expect(stored.state).toEqual({ $: "Stored", attempt: maximum, intent })
})

it("rejects unsupported numeric representations before entering native code", () => {
  for (const attempt of [-1n, maximum + 1n]) expect(() => core.initialize(attempt)).toThrow(TerminalCoreBoundaryFailure)
  for (const attempt of [0, 1.5, Infinity, NaN, "1", undefined])
    expect(() => Reflect.apply(core.initialize, undefined, [attempt])).toThrow(TerminalCoreBoundaryFailure)
  expect(() =>
    core.transition(core.initialize(1n), { $: "Select", attempt: 1n, intent, invocation: maximum + 1n })
  ).toThrow(TerminalCoreBoundaryFailure)
})

it("rejects malformed nested intent, state and event representations", () => {
  const state = core.initialize(1n)
  for (const event of [
    { $: "Select", attempt: 1n, intent: { ...intent, outcome: { $: "Failed" } }, invocation: 1n },
    { $: "Select", attempt: 1n, intent: { ...intent, payload: "1" }, invocation: 1n },
    { $: "StoredAck", attempt: 1n, intent, invocation: 1n },
    { $: "StorageFailed", attempt: 1n, operation: 1n },
    { $: "Other" }
  ])
    expect(() => Reflect.apply(core.transition, undefined, [state, event])).toThrow(TerminalCoreBoundaryFailure)
  expect(() =>
    Reflect.apply(core.transition, undefined, [
      { ...state, extra: true },
      { $: "StoredAck", attempt: 1n, intent }
    ])
  ).toThrow(TerminalCoreBoundaryFailure)
})
