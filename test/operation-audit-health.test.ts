import { Effect } from "effect"
import { expect, it } from "vitest"
import { OperationAudit, operationAuditLayer, withAuditSpan } from "../src/operation-audit/index.ts"

it("contains reporter failures, keeps the audit writer alive and exposes health without failing product work", async () => {
  const lines: string[] = []
  let writes = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* OperationAudit
      yield* Effect.void.pipe(withAuditSpan("conversation.context"))
      yield* audit.flush
      yield* Effect.void.pipe(withAuditSpan("conversation.persist"))
      yield* audit.flush
      expect(yield* audit.health).toMatchObject({ pending: 0, writeFailures: 1, reportFailures: 1 })
    }).pipe(
      Effect.provide(
        operationAuditLayer(
          {
            write: async (line) => {
              if (writes++ === 0) throw new Error("private storage path")
              lines.push(line)
            }
          },
          () => {
            throw new Error("private reporter error")
          }
        )
      )
    )
  )
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    name: "conversation.persist",
    outcome: "Succeeded",
    writeFailures: 1
  })
  expect(lines.join("")).not.toContain("private")
})

it("reports a broken audit sink once, retains failure counters and does not fail product work", async () => {
  const warnings: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* OperationAudit
      for (let index = 0; index < 3; index++) yield* Effect.void.pipe(withAuditSpan("conversation.context"))
      yield* audit.flush
      expect(yield* audit.health).toEqual({
        pending: 0,
        dropped: 0,
        writeFailures: 3,
        projectionFailures: 0,
        reportFailures: 0
      })
    }).pipe(
      Effect.provide(
        operationAuditLayer(
          {
            write: async () => {
              throw new Error("private path and token")
            }
          },
          (line) => {
            warnings.push(line)
          }
        )
      )
    )
  )
  expect(warnings).toEqual(["Operation audit write failed\n"])
})

it("bounds a blocked sink, reports overflow once and drains accepted records", async () => {
  let release: () => void = () => undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const warnings: string[] = []
  const lines: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* OperationAudit
      for (let index = 0; index < 600; index++) yield* Effect.void.pipe(withAuditSpan("conversation.context"))
      const health = yield* audit.health
      expect(health.pending).toBeLessThanOrEqual(513)
      expect(health.dropped).toBeGreaterThan(0)
      release()
      yield* audit.flush
      expect((yield* audit.health).pending).toBe(0)
      expect(lines).toHaveLength(health.pending)
      expect(lines.length + health.dropped).toBe(600)
    }).pipe(
      Effect.provide(
        operationAuditLayer(
          {
            write: async (line) => {
              await blocked
              lines.push(line)
            }
          },
          (line) => {
            warnings.push(line)
          }
        )
      )
    )
  )
  expect(warnings).toEqual(["Operation audit queue overflow\n"])
})

it("isolates unsafe error accessors and reports malformed causes without executing them", async () => {
  const lines: string[] = []
  const warnings: string[] = []
  const unsafe = Object.defineProperty({}, "message", {
    get: () => {
      throw new Error("must not execute")
    }
  })
  await Effect.runPromise(
    Effect.fail(unsafe).pipe(
      withAuditSpan("conversation.answer"),
      Effect.exit,
      Effect.provide(
        operationAuditLayer(
          {
            write: async (line) => {
              lines.push(line)
            }
          },
          (line) => {
            warnings.push(line)
          }
        )
      )
    )
  )
  expect(warnings).toEqual([])
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    outcome: "Failed",
    diagnostic: { category: "Runtime", reason: "UnknownFailure" }
  })
  expect(lines.join("")).not.toContain("must not execute")
})
