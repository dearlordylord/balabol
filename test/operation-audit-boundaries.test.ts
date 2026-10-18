import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect } from "effect"
import { expect, it } from "vitest"
import { auditFile, auditIdentity, operationAuditLayer, withAuditSpan } from "../src/operation-audit/index.ts"

it("exports structured failure details through the helper into a real private journal without explicit tracer wiring", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-audit-boundary-"))
  const path = join(directory, "operations.jsonl")
  try {
    await Effect.runPromise(
      Effect.fail({
        _tag: "AnswerFailed",
        message: "private conversation and token",
        diagnostic: { category: "Agent", reason: "Turns", limit: 8, secret: "private payload" }
      }).pipe(
        withAuditSpan("conversation.answer", "synthetic-response"),
        Effect.ignore,
        Effect.provide(operationAuditLayer(auditFile(path)))
      )
    )
    const text = await readFile(path, "utf8")
    const records: unknown[] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        name: "conversation.answer",
        outcome: "Failed",
        response: auditIdentity("synthetic-response"),
        diagnostic: { category: "Agent", reason: "Turns", limit: 8 }
      })
    )
    expect(text).not.toContain("private")
    expect(text).not.toContain("synthetic-response")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("retains each distinct cause and validates structured attributes instead of exporting raw exceptions", async () => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.failCause(
      Cause.combine(
        Cause.fail({ _tag: "KnowledgeRejected", code: "InvalidSchema", message: "private schema" }),
        Cause.combine(Cause.die(new Error("private defect")), Cause.interrupt())
      )
    ).pipe(
      withAuditSpan("agent.tool", undefined, {
        tool: "apply_knowledge",
        toolCalls: 2,
        session: auditIdentity("synthetic-session"),
        secret: "private attribute",
        provider: "private provider",
        modelCalls: -1
      }),
      Effect.exit,
      Effect.provide(
        operationAuditLayer({
          write: async (line) => {
            lines.push(line)
          }
        })
      )
    )
  )
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    name: "agent.tool",
    outcome: "Defect",
    tool: "apply_knowledge",
    toolCalls: 2,
    failures: expect.arrayContaining([
      expect.objectContaining({ kind: "Fail", diagnostic: { category: "Knowledge", reason: "InvalidSchema" } }),
      expect.objectContaining({ kind: "Die", diagnostic: { category: "Runtime", reason: "UnexpectedDefect" } }),
      expect.objectContaining({ kind: "Interrupt" })
    ])
  })
  expect(lines.join("")).not.toContain("private")
  expect(lines.join("")).not.toContain("modelCalls")
})
