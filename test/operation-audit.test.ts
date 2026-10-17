import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { expect, it } from "vitest"
import {
  auditFile,
  OperationAudit,
  auditIdentity,
  operationAuditLayer,
  withAuditSpan,
  finishAudit
} from "../src/operation-audit/index.ts"
it("persists real Effect parent/child failure spans without exporting private errors, values or attributes", async () => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const audit = yield* OperationAudit
        yield* Effect.fail({
          reason: "SynthesisPlanFailed",
          message: "private transcript",
          token: "private token"
        }).pipe(
          Effect.withSpan("speech.plan", { attributes: { secret: "private attribute" } }),
          Effect.withSpan("voice.synthesis", { attributes: { response: auditIdentity("response") } }),
          Effect.ignore,
          Effect.withTracer(audit.tracer)
        )
        yield* audit.flush
      })
    ).pipe(
      Effect.provide(
        operationAuditLayer({
          write: async (line) => {
            lines.push(line)
          }
        })
      )
    )
  )
  expect(lines).toHaveLength(2)
  const child: unknown = JSON.parse(lines[0] ?? "")
  const parent: unknown = JSON.parse(lines[1] ?? "")
  expect(child).toMatchObject({ name: "speech.plan", outcome: "Failed", reason: "SynthesisPlanFailed" })
  expect(parent).toMatchObject({ name: "voice.synthesis", outcome: "Failed", reason: "SynthesisPlanFailed" })
  expect(lines.join("")).not.toContain("private")
})
it("restores one response parent across independently scheduled mailbox work and flushes it on scope close", async () => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* OperationAudit
      yield* Effect.void.pipe(withAuditSpan("conversation.context", "response"), Effect.withTracer(audit.tracer))
      yield* Effect.void.pipe(withAuditSpan("voice.publication", "response"), Effect.withTracer(audit.tracer))
      yield* finishAudit("response", Exit.succeed(undefined))
    }).pipe(
      Effect.provide(
        operationAuditLayer({
          write: async (line) => {
            lines.push(line)
          }
        })
      )
    )
  )
  expect(lines).toHaveLength(3)
  const records = lines.map((line): { traceId: string; spanId: string; parentSpanId?: string; name: string } =>
    JSON.parse(line)
  )
  const parent = records.find((record) => record.name === "conversation.response")
  expect(parent).toBeDefined()
  expect(records.every((record) => record.traceId === parent?.traceId)).toBe(true)
  expect(
    records
      .filter((record) => record.name !== "conversation.response")
      .every((record) => record.parentSpanId === parent?.spanId)
  ).toBe(true)
})
it("distinguishes provider failure, cancellation and defects without exporting raw causes", async () => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* OperationAudit
      const effects: readonly Effect.Effect<never, unknown>[] = [
        Effect.fail("private error"),
        Effect.die("private defect"),
        Effect.interrupt,
        Effect.failCause(
          Cause.combine(Cause.fail({ code: "AudioUnavailable", message: "private error" }), Cause.interrupt())
        )
      ]
      for (const work of effects)
        yield* work.pipe(Effect.withSpan("voice.capture"), Effect.exit, Effect.withTracer(audit.tracer))
      yield* Effect.void.pipe(Effect.withSpan("private unregistered name"), Effect.withTracer(audit.tracer))
      yield* audit.flush
    }).pipe(
      Effect.provide(
        operationAuditLayer({
          write: async (line) => {
            lines.push(line)
          }
        })
      )
    )
  )
  expect(lines).toHaveLength(4)
  expect(lines.join("")).not.toContain("private")
  expect(lines.map((line): unknown => JSON.parse(line))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ outcome: "Failed" }),
      expect.objectContaining({ outcome: "Defect" }),
      expect.objectContaining({ outcome: "Cancelled" })
    ])
  )
})
it("retains bounded private audit files across rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-audit-"))
  const path = join(directory, "nested", "operations.jsonl")
  try {
    const storage = auditFile(path)
    await storage.write("first\n")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await writeFile(path, "x".repeat(4194304))
    await storage.write("second\n")
    expect(await readFile(path, "utf8")).toBe("second\n")
    expect((await stat(`${path}.previous`)).size).toBe(4194304)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
