import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Voice } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { decoratedConversation, temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
it("reconciles a durable final after uncertain storage acknowledgement and session end", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const conversation = decoratedConversation(database.path, (storage) => ({
    ...storage,
    open: () => storage.open(),
    close: () => storage.close(),
    load: () => storage.load(),
    appendRecords: (records) => storage.appendRecords(records),
    appendNode: (node) => storage.appendNode(node),
    checkpoint: async (value) => {
      if (value.cursor > 0) throw new Error("Fixture post-raw checkpoint failure")
      await storage.checkpoint(value)
    }
  }))
  const provider = fakeRecognitionLayer({
    languages: ["ru", "fr", "en"],
    scripts: [{ events: [{ kind: "Final", text: "Durable speech", spans: [] }], delayMillis: 0, failure: null }]
  })
  const voice = Voice.layer.pipe(
    Layer.provide(Layer.mergeAll(conversation, transport.layer, provider, fakeSynthesisLayer()))
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Voice
          const durable = yield* Conversation
          const join = yield* sessions.start()
          yield* transport.segment
          yield* Effect.sleep(50)
          yield* sessions.end(join.sessionId)
          const snapshot = yield* sessions.snapshot(join.sessionId, 0)
          expect(snapshot.events.filter((event) => event.kind !== "Output").map((event) => event.kind)).toEqual([
            "Final",
            "Error",
            "Ended",
            "Accepted"
          ])
          expect(snapshot.events.find((event) => event.kind === "Error")?.code).toBe("StorageUnavailable")
          const accepted = snapshot.events.find((event) => event.kind === "Accepted")
          expect(accepted?.receipt.text).toBe("Durable speech")
          expect((yield* durable.page({ limit: 100 })).messages).toEqual([accepted?.receipt])
          const repeated = yield* sessions.snapshot(join.sessionId, 0)
          expect(repeated.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
        })
      ).pipe(Effect.provide(Layer.merge(voice, conversation)))
    )
  } finally {
    await database.close()
  }
})
