import { Effect } from "effect"
import { expect, it } from "vitest"
import { answerRuntimeFailureMessage } from "../src/answer-generation/subscription-failure.ts"
import { Conversation } from "../src/conversation/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("retains the exhausted turn budget in the durable reply and accepts the next input", async () => {
  const database = await temporaryDatabase()
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
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId, text: "Synthetic budget exhaustion" })
          const failed = yield* waitForReply(conversation, deliveryId)
          expect(failed.state).toBe("Failed")
          expect(failed.error?.message).toBe("Answer stopped: agent turn limit reached; try a smaller request")
          expect((yield* conversation.reply(deliveryId)).error).toEqual(failed.error)
          expect(calls).toBe(8)
          const next = "22222222-2222-4222-8222-222222222222"
          yield* conversation.send({ deliveryId: next, text: "Synthetic recovery" })
          expect((yield* waitForReply(conversation, next)).state).toBe("Completed")
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
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
