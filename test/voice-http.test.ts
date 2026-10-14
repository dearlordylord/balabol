import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { Voice, voiceRoutes, VoiceJoin, VoiceSnapshot, SpeechResolutions } from "../src/voice/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
it("controls a session over real HTTP with a private scoped capability and bounded snapshot", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const conversation = replyLayer(database.path, fakeAnswerLayer())
  const voice = Voice.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        transport.layer,
        fakeRecognitionLayer(),
        conversation,
        fakeSynthesisLayer(),
        voiceAdmissionsFixture().pipe(Layer.provide(conversation))
      )
    )
  )
  const server = HttpRouter.serve(voiceRoutes).pipe(
    Layer.provide(voice),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const request = (path: string, method = "GET", secret = "", body?: unknown) =>
            Effect.promise(() =>
              fetch(`${address}${path}`, {
                method,
                headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
              })
            )
          const startInput = startVoiceRequest()
          const started = yield* request("/voice/sessions", "POST", "", startInput)
          const join = yield* Effect.promise(() => started.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VoiceJoin))
          )
          const retry = yield* request("/voice/sessions", "POST", "", {
            ...startInput,
            startRequestId: startInput.startRequestId.toUpperCase()
          })
          expect(yield* Effect.promise(() => retry.json())).toEqual(join)
          expect((yield* request("/voice/sessions", "POST", "", {})).status).toBe(400)
          const association = {
            backendIncarnationId: join.backendIncarnationId,
            sessionId: join.sessionId,
            deliveryId: crypto.randomUUID()
          }
          const recovered = yield* request("/voice/admissions/resolve", "POST", "", { admissions: [association] })
          expect(recovered.status).toBe(200)
          const recovery = yield* Effect.promise(() => recovered.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(SpeechResolutions))
          )
          expect(recovery.admissions).toEqual([{ ...association, status: "Unknown", receipt: null }])
          expect((yield* request("/voice/admissions/resolve", "POST", "", { admissions: [] })).status).toBe(400)
          expect(
            (yield* request("/voice/admissions/resolve", "POST", "", {
              admissions: [association, { ...association, deliveryId: association.deliveryId.toUpperCase() }]
            })).status
          ).toBe(400)
          const path = `/voice/sessions/${join.sessionId.toUpperCase()}`
          expect((yield* request("/voice/sessions", "POST", "", startVoiceRequest())).status).toBe(409)
          expect((yield* request(path)).status).toBe(401)
          expect((yield* request(`${path}?after=-1`, "GET", join.controlToken)).status).toBe(400)
          expect((yield* request("/voice/sessions/invalid", "GET", join.controlToken)).status).toBe(400)
          expect((yield* request(`/voice/sessions/${crypto.randomUUID()}`, "GET", join.controlToken)).status).toBe(404)
          expect((yield* request(`${path}/mute`, "POST", join.controlToken, { muted: "wrong" })).status).toBe(400)
          expect((yield* request(`${path}/mute`, "POST", join.controlToken, { muted: true })).status).toBe(200)
          const ended = yield* request(`${path}/end`, "POST", join.controlToken)
          const snapshot = yield* Effect.promise(() => ended.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VoiceSnapshot))
          )
          expect(snapshot.status).toBe("ended")
          const polled = yield* request(`${path}?after=${snapshot.sequence}`, "GET", join.controlToken)
          const empty = yield* Effect.promise(() => polled.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VoiceSnapshot))
          )
          expect(empty.events).toEqual([])
          expect(JSON.stringify(empty)).not.toContain(join.controlToken)
        })
      ).pipe(Effect.provide(server))
    )
  } finally {
    await database.close()
  }
})
