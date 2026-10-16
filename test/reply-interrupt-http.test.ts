import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { HttpServer, HttpRouter } from "effect/http"
import { expect, it } from "vitest"
import { AnswerFailed, AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation, Reply, conversationRoutes } from "../src/conversation/index.ts"
import type { DeliveryTicket } from "../src/conversation/index.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("interrupts an enrolled Waiting reply over HTTP without releasing a newer exact response", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const canceled = yield* Deferred.make<void>()
          let retryAttempts = 0
          const provider = Layer.succeed(AnswerGeneration, {
            capabilities: { languages: ["en"], output: "text-deltas" },
            generate: (request) => {
              if (request.input === "Retry input" && retryAttempts++ === 0)
                return Stream.fail(new AnswerFailed({ message: "Fixture first attempt failure" }))
              return Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
                Stream.flatMap(() => Stream.never),
                Stream.ensuring(Deferred.succeed(canceled, undefined))
              )
            }
          })
          const application = replyLayer(database.path, provider)
          const server = HttpRouter.serve(conversationRoutes).pipe(
            Layer.provideMerge(application),
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
          )
          yield* Effect.gen(function* () {
            const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
            const conversation = yield* Conversation
            const started = yield* Deferred.make<DeliveryTicket>()
            const registration = yield* conversation.registerReplyDelivery({ completionMillis: 5000 })
            yield* registration.updates.pipe(
              Stream.runForEach((update) =>
                update.kind === "Started" ? Deferred.succeed(started, update.ticket).pipe(Effect.asVoid) : Effect.void
              ),
              Effect.forkIn(yield* Effect.scope)
            )
            const input = { deliveryId: "ABCDEF11-1111-4111-8111-111111111111", text: "Accepted input" }
            yield* conversation.send(input)
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            const target = yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"))
            expect((yield* conversation.reply(input.deliveryId)).state).toBe("Waiting")
            const deleted = yield* Effect.tryPromise(() =>
              fetch(`${address}/conversation/replies/${input.deliveryId}`, { method: "DELETE" })
            )
            expect(deleted.status).toBe(204)
            expect((yield* conversation.reply(input.deliveryId)).state).toBe("Waiting")
            const post = (body: unknown) =>
              Effect.tryPromise(() =>
                fetch(`${address}/conversation/replies/interrupt`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body)
                })
              )
            const malformed = yield* post({ responseId: "invalid", inputDeliveryId: input.deliveryId })
            expect(malformed.status).toBe(400)
            const stopped = yield* post({
              responseId: target.responseId.toUpperCase(),
              inputDeliveryId: target.inputDeliveryId.toUpperCase()
            })
            expect(stopped.status).toBe(200)
            const reply = Schema.decodeUnknownSync(Reply)(yield* Effect.tryPromise(() => stopped.json()))
            expect(reply.state).toBe("Interrupted")
            yield* Deferred.await(canceled).pipe(Effect.timeout("2 seconds"))
            expect((yield* conversation.page({ limit: 100 })).messages[0]?.text).toBe(input.text)
            const next = { deliveryId: "ABCDEF22-2222-4222-8222-222222222222", text: "New input" }
            yield* conversation.send(next)
            const current = yield* conversation.reply(next.deliveryId)
            expect(current.state).toBe("Waiting")
            const stale = yield* post({ responseId: target.responseId, inputDeliveryId: target.inputDeliveryId })
            expect(stale.status).toBe(200)
            expect(yield* Effect.tryPromise(() => stale.json())).toBeNull()
            expect((yield* conversation.reply(next.deliveryId)).responseId).toBe(current.responseId)
            expect((yield* conversation.reply(next.deliveryId)).state).toBe("Waiting")
            expect(
              (yield* conversation.page({ limit: 100 })).messages
                .filter((message) => message.role === "user")
                .map((message) => message.text)
            ).toEqual([input.text, next.text])
            const retryInput = { deliveryId: "ABCDEF33-3333-4333-8333-333333333333", text: "Retry input" }
            yield* conversation.send(retryInput)
            const failed = yield* waitForReply(conversation, retryInput.deliveryId)
            expect(failed.state).toBe("Failed")
            const retried = yield* conversation.retryReply(retryInput.deliveryId)
            expect(retried.responseId).not.toBe(failed.responseId)
            const oldAttempt = yield* post({ responseId: failed.responseId, inputDeliveryId: failed.inputDeliveryId })
            expect(oldAttempt.status).toBe(200)
            expect(yield* Effect.tryPromise(() => oldAttempt.json())).toBeNull()
            expect((yield* conversation.reply(retryInput.deliveryId)).responseId).toBe(retried.responseId)
            expect((yield* conversation.reply(retryInput.deliveryId)).state).toBe("Waiting")
          }).pipe(Effect.scoped, Effect.provide(server))
        })
      )
    )
  } finally {
    await database.close()
  }
})
