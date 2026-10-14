import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { Voice, voiceRoutes, VoiceJoin, VoiceSnapshot } from "../src/voice/index.ts"
import { Conversation, conversationRoutes } from "../src/conversation/index.ts"
import { voiceOutputLayer, outputInput, waitForOutput } from "./voice-output-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
it("authorizes exact output readiness and canonical uppercase interruption identities over HTTP", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const application = voiceOutputLayer(database.path, transport)
  const server = HttpRouter.serve(Layer.merge(voiceRoutes, conversationRoutes)).pipe(
    Layer.provide(application),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const request = (path: string, secret: string, body: unknown) =>
            Effect.promise(() =>
              fetch(`${address}${path}`, {
                method: "POST",
                headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
                body: JSON.stringify(body)
              })
            )
          const started = yield* request("/voice/sessions", "", {})
          const join = yield* Effect.promise(() => started.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VoiceJoin))
          )
          yield* conversation.send(outputInput)
          const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (waiting?.manifest == null) throw new Error("Missing publication")
          const path = `/voice/sessions/${join.sessionId.toUpperCase()}/output`
          const ready = {
            responseId: waiting.responseId.toUpperCase(),
            outputEpoch: waiting.outputEpoch.toUpperCase(),
            trackSid: waiting.manifest.trackSid
          }
          expect((yield* request(`${path}/ready`, "wrong", ready)).status).toBe(401)
          expect((yield* request(`${path}/ready`, join.controlToken, { ...ready, trackSid: "other" })).status).toBe(409)
          expect(
            (yield* request(`${path}/ready`, join.controlToken, { ...ready, outputEpoch: "invalid" })).status
          ).toBe(400)
          expect((yield* request(`${path}/ready`, join.controlToken, ready)).status).toBe(200)
          const stopped = yield* request(`${path}/interrupt`, join.controlToken, {
            responseId: waiting.responseId.toUpperCase(),
            inputDeliveryId: waiting.inputDeliveryId.toUpperCase(),
            outputEpoch: waiting.outputEpoch.toUpperCase()
          })
          expect(stopped.status).toBe(200)
          const snapshot = yield* Effect.promise(() => stopped.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VoiceSnapshot))
          )
          expect(snapshot.output?.status).toBe("Interrupted")
          expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
          expect(
            (yield* request(`${path}/interrupt`, join.controlToken, {
              responseId: waiting.responseId,
              inputDeliveryId: waiting.inputDeliveryId,
              outputEpoch: waiting.outputEpoch
            })).status
          ).toBe(200)
        })
      ).pipe(Effect.provide(Layer.merge(server, application)))
    )
  } finally {
    await database.close()
  }
})
