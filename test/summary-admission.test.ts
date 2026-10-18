import { operationAuditLayer } from "../src/operation-audit/index.ts"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { SummaryFailed, SummaryGeneration } from "../src/summary-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const first = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "long prior input ".repeat(100) }
const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "follow-up" }
for (const outcome of ["pending", "failed"] as const)
  it(`honestly exposes ${outcome} prior summaries and never substitutes empty context`, async () => {
    const fixture = await temporaryDatabase()
    const lines: string[] = []
    let jobs = 0
    const summary = Layer.succeed(SummaryGeneration, {
      summarize: () =>
        Effect.suspend(() => {
          jobs++
          return outcome === "pending"
            ? Effect.never
            : Effect.fail(
                new SummaryFailed({
                  message: "summary backend unavailable",
                  diagnostic: { category: "Memory", reason: "Unavailable" }
                })
              )
        })
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.send(first)
            expect((yield* waitForReply(conversation, first.deliveryId)).state).toBe("Completed")
            yield* conversation.send(second)
            const reply = yield* waitForReply(conversation, second.deliveryId)
            expect(reply.state).toBe("Failed")
            expect(reply.error?.code).toBe(outcome === "pending" ? "MemoryPending" : "MemoryFailed")
            expect(reply.text).toBe("")
            expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.role)).toEqual([
              "user",
              "assistant",
              "user"
            ])
            expect(jobs).toBeGreaterThan(0)
          })
        ).pipe(
          Effect.provide(
            replyLayer(
              fixture.path,
              fakeAnswerLayer(0),
              { contextWaitAttempts: 2, contextWaitMillis: 5 },
              summary
            ).pipe(
              Layer.provideMerge(
                operationAuditLayer({
                  write: async (line) => {
                    lines.push(line)
                  }
                })
              )
            )
          )
        )
      )
      const records: unknown[] = lines.map((line) => JSON.parse(line))
      expect(records).toContainEqual(
        expect.objectContaining({
          name: "memory.summary",
          outcome: outcome === "pending" ? "Cancelled" : "Failed",
          job: expect.stringMatching(/^[a-f0-9]{32}$/u),
          attempt: expect.stringMatching(/^[a-f0-9]{32}$/u)
        })
      )
      expect(lines.join("")).not.toContain(first.text)
      if (outcome === "failed")
        expect(records).toContainEqual(
          expect.objectContaining({ name: "memory.summary", diagnostic: { category: "Memory", reason: "Unavailable" } })
        )
    } finally {
      await fixture.close()
    }
  })
