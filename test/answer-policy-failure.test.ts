import { OperationAudit, operationAuditLayer } from "../src/operation-audit/index.ts"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { answerRuntimeDiagnostic, answerRuntimeFailureMessage } from "../src/answer-generation/subscription-failure.ts"
import { Conversation } from "../src/conversation/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("retains the exhausted turn budget in the durable reply and accepts the next input", async () => {
  const database = await temporaryDatabase()
  const lines: string[] = []
  let calls = 0
  const provider = knowledgeAnswerLayer(async () => {
    calls++
    return calls <= 8 ? tool("inspect_knowledge", {}, `inspect-${calls}`) : answer("Recovered")
  })
  const deliveryId = "11111111-1111-4111-8111-111111111111"
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const audit = yield* OperationAudit
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId, text: "Synthetic budget exhaustion" })
          const failed = yield* waitForReply(conversation, deliveryId)
          expect(failed.state).toBe("Failed")
          expect(failed.error?.message).toBe("Answer stopped: agent turn limit reached; try a smaller request")
          expect((yield* conversation.reply(deliveryId)).error).toEqual(failed.error)
          expect(calls).toBe(8)
          yield* audit.flush
          const records: unknown[] = lines.map((line) => JSON.parse(line))
          expect(records).toContainEqual(
            expect.objectContaining({
              name: "agent.run",
              outcome: "Failed",
              diagnostic: expect.objectContaining({ category: "Agent", reason: "Turns", limit: 8 })
            })
          )
          expect(records).toContainEqual(expect.objectContaining({ name: "agent.tool", outcome: "Succeeded" }))
          expect(lines.join("")).not.toContain("Synthetic budget exhaustion")
          const next = "22222222-2222-4222-8222-222222222222"
          yield* conversation.send({ deliveryId: next, text: "Synthetic recovery" })
          expect((yield* waitForReply(conversation, next)).state).toBe("Completed")
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" }).pipe(
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
  } finally {
    await database.close()
  }
})

it.each([
  ["Agent exceeded its 8 Tool Call limit", "tool-call limit reached; try a smaller request"],
  ["Agent exceeded its 1m duration limit", "time limit reached; try again"],
  ["Agent reached its 3 consecutive Tool Call failure limit", "repeated tool failures; try again"],
  ["Agent exceeded its 100 token budget", "token budget reached; try a smaller request"],
  ["Agent exceeded its 100 microdollar cost budget", "cost budget reached; try a smaller request"]
])("safely identifies the local policy failure %s", (message, reason) => {
  expect(answerRuntimeFailureMessage("AgentPolicyError", message)).toBe(`Answer stopped: agent ${reason}`)
})

it("never exposes arbitrary policy or provider details", () => {
  const privateMessage = "Private provider payload: Agent exceeded its 8 Turn limit"
  expect(answerRuntimeFailureMessage("AgentPolicyError", privateMessage)).not.toContain(privateMessage)
  expect(answerRuntimeFailureMessage("ProviderError", "Agent exceeded its 8 Turn limit")).toBe(
    "Answer runtime or knowledge tool failed (ProviderError)"
  )
})

it("retains only exact policy template metadata", () => {
  expect(answerRuntimeDiagnostic("AgentPolicyError", "Agent exceeded its 8 Turn limit")).toEqual({
    category: "Agent",
    reason: "Turns",
    limit: 8
  })
  expect(answerRuntimeDiagnostic("AgentPolicyError", "Private input Agent exceeded its 8 Turn limit")).toEqual({
    category: "Agent",
    reason: "UnknownPolicy"
  })
})

it("persists a returned-to-model dictionary failure even when the answer succeeds", async () => {
  const database = await temporaryDatabase()
  const lines: string[] = []
  let calls = 0
  const provider = knowledgeAnswerLayer(async () =>
    ++calls === 1
      ? tool("lookup_dictionary", { language: "fr", word: "synthetic-private-word" }, "dictionary")
      : answer("Dictionary unavailable")
  )
  const deliveryId = "33333333-3333-4333-8333-333333333333"
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const audit = yield* OperationAudit
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId, text: "Synthetic private request" })
          expect((yield* waitForReply(conversation, deliveryId)).state).toBe("Completed")
          yield* audit.flush
          const records: unknown[] = lines.map((line) => JSON.parse(line))
          expect(records).toContainEqual(
            expect.objectContaining({
              name: "agent.tool",
              outcome: "Failed",
              tool: "lookup_dictionary",
              diagnostic: expect.objectContaining({ category: "Dictionary", reason: "Disabled" })
            })
          )
          expect(records).toContainEqual(
            expect.objectContaining({ name: "agent.tool", failureHandling: "returned-to-model", outcome: "Failed" })
          )
          expect(records).toContainEqual(
            expect.objectContaining({
              name: "agent.run",
              outcome: "Succeeded",
              modelCalls: 2,
              toolCalls: 1,
              finishReason: "model-stop"
            })
          )
          expect(lines.join("")).not.toContain("synthetic-private-word")
          expect(lines.join("")).not.toContain("Synthetic private request")
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" }).pipe(
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
  } finally {
    await database.close()
  }
})
