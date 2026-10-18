import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import type { AnswerProgress } from "../src/answer-generation/contracts.ts"
import { Conversation } from "../src/conversation/index.ts"
import { OperationAudit, operationAuditLayer } from "../src/operation-audit/index.ts"
import { UsageLedger, sqliteUsageLayer } from "../src/usage/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, frame, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("retries only the model step after a committed tool and accounts/audits every physical request", async () => {
  const database = await temporaryDatabase()
  const lines: string[] = []
  const requests: unknown[] = []
  let commits = 0
  const provider = knowledgeAnswerLayer(
    async (request) => {
      requests.push(request)
      if (requests.length === 1)
        return tool(
          "apply_knowledge",
          {
            reason: "Keep synthetic expression",
            types: [{ name: "Expression", fields: [{ name: "text", kind: "string", required: true }] }],
            creates: [
              {
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                type: "Expression",
                values: { text: "synthetic private word" }
              }
            ],
            updates: [],
            relationTypes: [],
            relationCreates: []
          },
          "keep"
        )
      expect(lastToolResult(request)).toMatchObject({ revision: 1 })
      return requests.length === 2
        ? new Response(
            frame({ type: "response.failed", response: { error: { code: "unrecognized_provider_failure" } } })
          )
        : answer("Saved once")
    },
    (durable) => ({
      ...durable,
      commit: (request) =>
        Effect.sync(() => {
          commits++
        }).pipe(Effect.andThen(durable.commit(request)))
    })
  )
  const accounting = sqliteUsageLayer(database.path)
  const audit = operationAuditLayer({
    write: async (line) => {
      lines.push(line)
    }
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const deliveryId = "11111111-1111-4111-8111-111111111111"
          yield* conversation.send({ deliveryId, text: "Synthetic private request" })
          expect((yield* waitForReply(conversation, deliveryId)).state).toBe("Completed")
          expect(commits).toBe(1)
          expect(requests).toHaveLength(3)
          expect(requests[2]).toEqual(requests[1])
          const snapshot = yield* (yield* UsageLedger).read
          expect(snapshot.totals.find((item) => item.category === "chat")).toMatchObject({ attempts: 3 })
          expect(snapshot.recent.map((item) => item.outcome).sort()).toEqual(["completed", "completed", "failed"])
          expect(new Set(snapshot.recent.map((item) => item.id)).size).toBe(3)
          yield* (yield* OperationAudit).flush
          const records: unknown[] = lines.map((line) => JSON.parse(line))
          expect(
            records.filter(
              (record) =>
                typeof record === "object" &&
                record !== null &&
                "name" in record &&
                record.name === "subscription.inference"
            )
          ).toHaveLength(3)
          expect(records).toContainEqual(
            expect.objectContaining({
              name: "subscription.inference",
              outcome: "Failed",
              diagnostic: expect.objectContaining({ category: "Subscription", reason: "Failed" })
            })
          )
          expect(lines.join("")).not.toContain("Synthetic private request")
          expect(lines.join("")).not.toContain("synthetic private word")
          expect(lines.join("")).not.toContain("unrecognized_provider_failure")
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" }).pipe(
            Layer.provideMerge(accounting),
            Layer.provideMerge(audit)
          )
        )
      )
    )
  } finally {
    await database.close()
  }
})

it("rejects a late retry callback from an interrupted response", async () => {
  const database = await temporaryDatabase()
  let progress: AnswerProgress | undefined
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en"], output: "text-deltas" },
    generate: (_request, observer) =>
      Stream.unwrap(
        Effect.sync(() => {
          progress = observer
          return Stream.never
        })
      )
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const deliveryId = "11111111-1111-4111-8111-111111111111"
          yield* conversation.send({ deliveryId, text: "Synthetic pending answer" })
          for (let index = 0; progress === undefined && index < 100; index++) yield* Effect.sleep(5)
          const observer = progress
          if (observer === undefined) throw new Error("Missing provider progress boundary")
          yield* conversation.cancelReply(deliveryId)
          const before = yield* conversation.reply(deliveryId)
          yield* observer({ kind: "Retry", attempt: 2, maximumAttempts: 3 }).pipe(Effect.exit)
          expect(yield* conversation.reply(deliveryId)).toEqual(before)
          expect(before.retry).toBeUndefined()
        })
      ).pipe(Effect.provide(replyLayer(database.path, provider)))
    )
  } finally {
    await database.close()
  }
})

it("rejects aggregate provider text overflow without losing the accepted input or prior safe prefix", async () => {
  const database = await temporaryDatabase()
  const safePrefix = "a".repeat(60000)
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en"], output: "text-deltas" },
    generate: () =>
      Stream.make(
        { kind: "Delta", text: safePrefix, languageSpans: [] },
        { kind: "Delta", text: "b".repeat(60000), languageSpans: [] },
        { kind: "Completed" }
      )
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const deliveryId = "11111111-1111-4111-8111-111111111111"
          yield* conversation.send({ deliveryId, text: "Synthetic bounded output" })
          const failed = yield* waitForReply(conversation, deliveryId)
          expect(failed.state).toBe("Failed")
          expect(failed.error).toMatchObject({
            code: "ProviderFailed",
            message: "Provider output exceeds bounded valid text and annotations"
          })
          expect(failed.text).toBe(safePrefix)
          expect((yield* conversation.page({ limit: 100 })).messages.map((item) => item.text)).toEqual([
            "Synthetic bounded output"
          ])
        })
      ).pipe(Effect.provide(replyLayer(database.path, provider)))
    )
  } finally {
    await database.close()
  }
})
