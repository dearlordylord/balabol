import { voiceAdmissionsFixture, startVoiceRequest } from "./voice-admission-fixture.ts"
import { Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import { Voice, VoiceAdmissions } from "../src/voice/index.ts"
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
    Layer.provide(
      Layer.mergeAll(
        conversation,
        transport.layer,
        provider,
        fakeSynthesisLayer(),
        voiceAdmissionsFixture().pipe(Layer.provide(conversation))
      )
    )
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Voice
          const durable = yield* Conversation
          const join = yield* sessions.start(startVoiceRequest())
          yield* transport.segment
          for (let index = 0; !transport.published.some((event) => event.kind === "Error") && index < 200; index++)
            yield* Effect.sleep(5)
          expect(transport.published.some((event) => event.kind === "Error")).toBe(true)
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
          if (accepted === undefined) throw new Error("Expected durable acceptance")
          const association = {
            backendIncarnationId: join.backendIncarnationId,
            sessionId: join.sessionId,
            deliveryId: accepted.receipt.deliveryId
          }
          expect((yield* sessions.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Accepted")
          const repeated = yield* sessions.snapshot(join.sessionId, 0)
          expect(repeated.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
        })
      ).pipe(Effect.provide(Layer.merge(voice, conversation)))
    )
  } finally {
    await database.close()
  }
})
for (const rejected of [false, true])
  it(`does not assert nonacceptance while a finalized admission can still settle (${rejected ? "rejected" : "accepted"})`, async () => {
    const database = await temporaryDatabase()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = voiceTransportFixture()
    const conversation = decoratedConversation(database.path, (storage) => ({
      ...storage,
      open: () => storage.open(),
      close: () => storage.close(),
      load: () => storage.load(),
      appendNode: (node) => storage.appendNode(node),
      checkpoint: (value) => storage.checkpoint(value),
      appendRecords: async (records) => {
        await gate
        if (rejected) throw new Error("Fixture definite pre-write failure")
        return storage.appendRecords(records)
      }
    }))
    const provider = fakeRecognitionLayer({
      languages: ["ru", "fr", "en"],
      scripts: [
        { events: [{ kind: "Final", text: "Pending identified speech", spans: [] }], delayMillis: 0, failure: null }
      ]
    })
    const voice = Voice.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          conversation,
          transport.layer,
          provider,
          fakeSynthesisLayer(),
          voiceAdmissionsFixture().pipe(Layer.provide(conversation))
        )
      )
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sessions = yield* Voice
            const durable = yield* Conversation
            const join = yield* sessions.start(startVoiceRequest())
            yield* transport.segment
            yield* Effect.sleep(50)
            const final = (yield* sessions.snapshot(join.sessionId, 0)).pending[0]
            if (final === undefined) throw new Error("Expected Final before durable acknowledgement")
            const association = {
              backendIncarnationId: final.backendIncarnationId,
              sessionId: join.sessionId,
              deliveryId: final.deliveryId
            }
            expect((yield* sessions.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Unknown")
            const ending = yield* sessions.end(join.sessionId).pipe(Effect.forkChild)
            yield* Effect.sleep(10)
            expect(transport.closed()).toBe(true)
            expect((yield* sessions.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Unknown")
            release?.()
            yield* Effect.sleep(100)
            yield* Fiber.join(ending)
            expect((yield* sessions.resolve({ admissions: [association] })).admissions[0]?.status).toBe(
              rejected ? "NotAccepted" : "Accepted"
            )
            expect(
              (yield* durable.page({ limit: 100 })).messages.filter((message) => message.role === "user")
            ).toHaveLength(rejected ? 0 : 1)
          }).pipe(Effect.ensuring(Effect.sync(() => release?.())))
        ).pipe(Effect.provide(Layer.merge(voice, conversation)))
      )
    } finally {
      release?.()
      await database.close()
    }
  })
it("keeps a read-back durable acceptance when its original acknowledgement later fails", async () => {
  const database = await temporaryDatabase()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = voiceTransportFixture()
  const conversation = decoratedConversation(database.path, (storage) => ({
    ...storage,
    open: () => storage.open(),
    close: () => storage.close(),
    load: () => storage.load(),
    appendRecords: (records) => storage.appendRecords(records),
    appendNode: (node) => storage.appendNode(node),
    checkpoint: async (value) => {
      if (value.cursor === 0) return storage.checkpoint(value)
      await gate
      throw new Error("Fixture delayed post-raw acknowledgement failure")
    }
  }))
  const admissions = voiceAdmissionsFixture().pipe(Layer.provide(conversation))
  const provider = fakeRecognitionLayer({
    languages: ["ru", "fr", "en"],
    scripts: [
      { events: [{ kind: "Final", text: "Durable before acknowledgement", spans: [] }], delayMillis: 0, failure: null }
    ]
  })
  const voice = Voice.layer.pipe(
    Layer.provide(Layer.mergeAll(conversation, transport.layer, provider, fakeSynthesisLayer(), admissions))
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Voice
          const evidence = yield* VoiceAdmissions
          const join = yield* sessions.start(startVoiceRequest())
          yield* transport.segment
          let snapshot = yield* sessions.snapshot(join.sessionId, 0)
          for (let index = 0; snapshot.pending[0]?.receipt == null && index < 200; index++) {
            yield* Effect.sleep(5)
            snapshot = yield* sessions.snapshot(join.sessionId, 0)
          }
          const pending = snapshot.pending[0]
          if (pending?.receipt == null)
            throw new Error("Expected read-back raw receipt while acknowledgement is pending")
          const association = {
            backendIncarnationId: pending.backendIncarnationId,
            sessionId: join.sessionId,
            deliveryId: pending.deliveryId
          }
          expect((yield* evidence.find(association))?.state).toBe("Open")
          release?.()
          for (let index = 0; (yield* evidence.find(association))?.state !== "Sealed" && index < 200; index++)
            yield* Effect.sleep(5)
          expect((yield* evidence.find(association))?.state).toBe("Sealed")
          const settled = yield* sessions.snapshot(join.sessionId, 0)
          expect(settled.pending[0]?.receipt).toEqual(pending.receipt)
          expect(settled.pending[0]?.error).toBeNull()
          expect(settled.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
        }).pipe(Effect.ensuring(Effect.sync(() => release?.())))
      ).pipe(Effect.provide(Layer.mergeAll(voice, conversation, admissions)))
    )
  } finally {
    release?.()
    await database.close()
  }
})
