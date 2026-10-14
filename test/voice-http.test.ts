import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { Voice, voiceRoutes, VoiceJoin, VoiceSnapshot } from "../src/voice/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { conversationLayer } from "../src/bootstrap/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
it("controls a session over real HTTP with a private scoped capability and bounded snapshot", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const voice = Voice.layer.pipe(
    Layer.provide(
      Layer.mergeAll(transport.layer, fakeRecognitionLayer(), conversationLayer(database.path), fakeSynthesisLayer())
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
          const started = yield* request("/voice/sessions", "POST")
          const join = yield* Effect.promise(() => started.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(VoiceJoin))
          )
          const path = `/voice/sessions/${join.sessionId.toUpperCase()}`
          expect((yield* request("/voice/sessions", "POST")).status).toBe(409)
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
