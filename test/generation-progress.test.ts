import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation, Reply } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

it("exposes actual generation before its first token and text readiness before delivery", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const answer = Layer.succeed(AnswerGeneration, {
            capabilities: { languages: ["en"], output: "text-deltas" },
            generate: () =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return Stream.fromIterable([
                    { kind: "Delta" as const, text: "Ready", languageSpans: [] },
                    { kind: "Completed" as const }
                  ])
                })
              )
          })
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.registerReplyDelivery({ completionMillis: 5000 })
            const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "Hello" })
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            const generating = yield* conversation.reply(input.deliveryId)
            expect(generating.state).toBe("Waiting")
            expect(generating.text).toBe("")
            expect(generating.generationStarted).toBe(true)
            expect(generating.generationCompleted).toBe(false)
            expect(generating.sequence).toBeGreaterThan(0)
            yield* Deferred.succeed(release, undefined)
            let ready = generating
            for (let attempt = 0; !ready.generationCompleted && attempt < 100; attempt++) {
              yield* Effect.sleep(5)
              ready = yield* conversation.reply(input.deliveryId)
            }
            expect(ready.state).toBe("Delivering")
            expect(ready.generationStarted).toBe(true)
            expect(ready.generationCompleted).toBe(true)
            expect(ready.text).toBe("Ready")
            expect(ready.sequence).toBeGreaterThan(generating.sequence)
          }).pipe(
            Effect.provide(replyLayer(database.path, answer)),
            Effect.ensuring(Deferred.succeed(release, undefined))
          )
        })
      )
    )
  } finally {
    await database.close()
  }
})

it("validates generation evidence while preserving legacy reply compatibility", () => {
  const legacy = {
    responseId: "11111111-1111-4111-8111-111111111111",
    inputDeliveryId: "22222222-2222-4222-8222-222222222222",
    sequence: 0,
    state: "Waiting",
    text: "",
    error: null,
    receipt: null
  }
  const decode = Schema.decodeUnknownSync(Reply)
  expect(decode(legacy)).toEqual(legacy)
  expect(decode({ ...legacy, generationStarted: true, generationCompleted: false }).generationStarted).toBe(true)
  expect(
    decode({ ...legacy, state: "Delivering", text: "Ready", generationStarted: true, generationCompleted: true })
      .generationCompleted
  ).toBe(true)
  expect(() => decode({ ...legacy, generationCompleted: true })).toThrow()
  expect(() => decode({ ...legacy, generationStarted: false, generationCompleted: true })).toThrow()
  expect(() => decode({ ...legacy, generationStarted: "true" })).toThrow()
  expect(() => decode({ ...legacy, generationCompleted: "true" })).toThrow()
})
