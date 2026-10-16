import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, uniiLayer, sqliteLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const waitForStreaming = (conversation: Conversation["Service"], id: string) =>
  Effect.gen(function* () {
    let reply = yield* conversation.reply(id)
    for (let index = 0; reply.state !== "Streaming" && index < 100; index++) {
      yield* Effect.sleep(5)
      reply = yield* conversation.reply(id)
    }
    expect(reply.state).toBe("Streaming")
    return reply
  })
const streamingAnswer = Layer.succeed(AnswerGeneration, {
  capabilities: { languages: ["en"], output: "text-deltas" },
  generate: () =>
    Stream.concat(Stream.succeed({ kind: "Delta", text: "ongoing answer", languageSpans: [] }), Stream.never)
})
const application = <E>(memory: Layer.Layer<Memory, E>) =>
  Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        memory,
        streamingAnswer,
        Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
      )
    )
  )

it("keeps an independent retry alive on duplicate old fences and revokes it on a fresh fence", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const source = yield* conversation.openInputSource()
          const input = yield* conversation.send({
            deliveryId: crypto.randomUUID(),
            text: "independent retry authority"
          })
          yield* waitForStreaming(conversation, input.deliveryId)
          yield* conversation.cancelReply(input.deliveryId)
          expect((yield* conversation.reply(input.deliveryId)).error?.code).toBe("Cancelled")
          const fence = { capability: source, sequence: 1, fenceId: crypto.randomUUID() }
          const original = yield* conversation.fenceSpeech(fence)
          const retry = yield* conversation.retryReply(input.deliveryId)
          const streaming = yield* waitForStreaming(conversation, input.deliveryId)
          expect(streaming.responseId).toBe(retry.responseId)
          expect(yield* conversation.fenceSpeech(fence)).toEqual(original)
          expect((yield* conversation.reply(input.deliveryId)).state).toBe("Streaming")
          yield* conversation.fenceSpeech({ capability: source, sequence: 2, fenceId: crypto.randomUUID() })
          let final = yield* conversation.reply(input.deliveryId)
          for (let index = 0; final.state !== "Interrupted" && index < 100; index++) {
            yield* Effect.sleep(5)
            final = yield* conversation.reply(input.deliveryId)
          }
          expect(final.state).toBe("Interrupted")
          expect(final.responseId).toBe(retry.responseId)
          expect(final.text).toBe(streaming.text)
          expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.role)).toEqual([
            "user",
            "assistant"
          ])
        })
      ).pipe(Effect.provide(application(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path))))))
    )
  } finally {
    await database.close()
  }
})

it("rejects a delayed retry lookup after a newer input becomes the conversation intent", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let blocking = false
          const controlled = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                latestInput: () =>
                  real
                    .latestInput()
                    .pipe(
                      Effect.flatMap((input) =>
                        blocking
                          ? Deferred.succeed(entered, undefined).pipe(
                              Effect.andThen(Deferred.await(release)),
                              Effect.as(input)
                            )
                          : Effect.succeed(input)
                      )
                    )
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "old failed input" })
            yield* waitForStreaming(conversation, input.deliveryId)
            yield* conversation.cancelReply(input.deliveryId)
            blocking = true
            const retry = yield* conversation.retryReply(input.deliveryId).pipe(Effect.result, Effect.forkChild)
            yield* Deferred.await(entered)
            const newer = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "new current input" })
            blocking = false
            yield* Deferred.succeed(release, undefined)
            const result = yield* Fiber.join(retry)
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") expect(result.failure._tag).toBe("ReplyBusy")
            const current = yield* waitForStreaming(conversation, newer.deliveryId)
            expect(current.inputDeliveryId).toBe(newer.deliveryId)
            expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.role)).toEqual(["user", "user"])
          }).pipe(Effect.provide(application(controlled)))
        })
      )
    )
  } finally {
    await database.close()
  }
})
