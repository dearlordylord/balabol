import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, uniiLayer, sqliteLayer } from "../src/memory/index.ts"
import { AnswerGeneration, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("rejects the response of an old voice origin after fresh text despite an unchanged source sequence", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const source = yield* conversation.openInputSource()
          yield* conversation.fenceSpeech({ capability: source, sequence: 1, fenceId: crypto.randomUUID() })
          yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "new text" })
          const reservation = yield* conversation.registerInput({
            message: { deliveryId: crypto.randomUUID(), text: "late old speech" },
            source: { capability: source, sequence: 1 }
          })
          const receipt = yield* conversation.submitInput(reservation)
          const reply = yield* conversation.reply(receipt.deliveryId)
          expect(reply.state).toBe("Interrupted")
          expect(reply.text).toBe("")
          expect(reply.receipt?.outcome).toBe("interrupted")
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
  } finally {
    await database.close()
  }
})

it("does not revoke a newer active response when an older accepted text delivery is retried", async () => {
  const database = await temporaryDatabase()
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en"], output: "text-deltas" },
    generate: () => Stream.never
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const first = { deliveryId: crypto.randomUUID(), text: "first input" }
          const receipt = yield* conversation.send(first)
          const next = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "second input" })
          const before = yield* conversation.reply(next.deliveryId)
          expect(before.state).toBe("Waiting")
          expect(yield* conversation.send(first)).toEqual(receipt)
          expect(yield* conversation.reply(next.deliveryId)).toEqual(before)
        })
      ).pipe(Effect.provide(replyLayer(database.path, answer)))
    )
  } finally {
    await database.close()
  }
})

it("coalesces concurrent identified input before a delayed lookup miss and owns an immutable payload", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const message = { deliveryId: crypto.randomUUID(), text: "original payload" }
          let firstLookup = true
          const controlledMemory = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                find: (id) =>
                  Effect.gen(function* () {
                    const evidence = yield* real.find(id)
                    if (firstLookup && id === message.deliveryId) {
                      firstLookup = false
                      yield* Deferred.succeed(entered, undefined)
                      yield* Deferred.await(release)
                    }
                    return evidence
                  })
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          const application = Conversation.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                controlledMemory,
                fakeAnswerLayer(0),
                Layer.succeed(ReplyConfiguration, defaultReplySettings)
              )
            )
          )
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const scope = yield* Effect.scope
            const reservation = yield* conversation.registerInput({ message })
            yield* Deferred.await(entered)
            const duplicate = yield* conversation.registerInput({ message })
            expect(duplicate).toEqual(reservation)
            message.text = "external mutation"
            const first = yield* conversation.submitInput(reservation).pipe(Effect.forkIn(scope))
            const second = yield* conversation.submitInput(duplicate).pipe(Effect.forkIn(scope))
            yield* Deferred.succeed(release, undefined)
            const receipt = yield* Fiber.join(first)
            expect(yield* Fiber.join(second)).toEqual(receipt)
            expect(receipt.text).toBe("original payload")
            expect((yield* conversation.page({ limit: 100 })).messages.filter((row) => row.role === "user")).toEqual([
              receipt
            ])
          }).pipe(Effect.provide(application))
        })
      )
    )
  } finally {
    await database.close()
  }
})
