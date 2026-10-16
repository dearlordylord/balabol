import { Deferred, Effect, Layer } from "effect"
import { expect, it } from "vitest"
import type { SpeechAdmission } from "../src/voice/index.ts"
import {
  Voice,
  VoiceAdmissions,
  VoiceTransport,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { Conversation, type Message } from "../src/conversation/index.ts"
import { withVoiceOutput, voiceOutputLayer, classifiedVoiceInput } from "./voice-output-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
it("retries the same bootstrap without another room or refreshed credentials", () =>
  withVoiceOutput((transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const request = { ...startVoiceRequest(), muted: true }
      const first = yield* voice.start(request)
      const again = yield* voice.start({ ...request, startRequestId: request.startRequestId.toUpperCase() })
      expect(again).toEqual(first)
      expect(transport.opens()).toBe(1)
      yield* transport.segment
      expect((yield* voice.snapshot(first.sessionId, 0)).pending).toEqual([])
      yield* voice.mute(first.sessionId, false)
      expect(yield* voice.start(request)).toEqual(first)
      expect((yield* Effect.flip(voice.start({ ...request, muted: false }))).code).toBe("StartConflict")
      yield* voice.end(first.sessionId)
      expect((yield* Effect.flip(voice.start(request))).code).toBe("StartExpired")
      const next = yield* voice.start(startVoiceRequest())
      expect(next.sessionId).not.toBe(first.sessionId)
      expect(next.backendIncarnationId).toBe(first.backendIncarnationId)
      expect((yield* voice.snapshot(next.sessionId, 0)).output).toBeNull()
    })
  ))
it("resolves only exact durable speech associations and seals old admissions on restart", async () => {
  const database = await temporaryDatabase()
  let association: SpeechAdmission = {
    backendIncarnationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID()
  }
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const admissions = yield* VoiceAdmissions
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          association = {
            backendIncarnationId: join.backendIncarnationId,
            sessionId: join.sessionId,
            deliveryId: association.deliveryId
          }
          yield* admissions.begin({ ...association, text: "Unaccepted speech" })
          expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Unknown")
          const forged = { ...association, sessionId: crypto.randomUUID() }
          expect((yield* voice.resolve({ admissions: [forged] })).admissions[0]?.status).toBe("Unknown")
          expect(
            (yield* voice.resolve({ admissions: [{ ...association, deliveryId: crypto.randomUUID() }] })).admissions[0]
              ?.status
          ).toBe("Unknown")
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, transport)))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const response = yield* voice.resolve({
            admissions: [
              {
                backendIncarnationId: association.backendIncarnationId.toUpperCase(),
                sessionId: association.sessionId.toUpperCase(),
                deliveryId: association.deliveryId.toUpperCase()
              }
            ]
          })
          expect(response.admissions).toEqual([{ ...association, status: "NotAccepted", receipt: null }])
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, voiceTransportFixture())))
    )
  } finally {
    await database.close()
  }
})
it("a finalized accepted input survives End and backend restart without replay or append", async () => {
  const database = await temporaryDatabase()
  let acceptedReceipt: Message | undefined
  let association: SpeechAdmission = {
    backendIncarnationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID()
  }
  try {
    const transport = voiceTransportFixture()
    const capture = await Effect.runPromise(classifiedVoiceInput())
    const accepted = Deferred.makeUnsafe<void>()
    const transportLayer = Layer.effect(
      VoiceTransport,
      Effect.gen(function* () {
        const base = yield* VoiceTransport
        return VoiceTransport.of({
          open: (...args) =>
            base
              .open(...args)
              .pipe(
                Effect.map((opened) => ({
                  ...opened,
                  connection: {
                    ...opened.connection,
                    publish: (event) =>
                      opened.connection
                        .publish(event)
                        .pipe(
                          Effect.andThen(
                            event.kind === "Accepted" ? Deferred.succeed(accepted, undefined) : Effect.void
                          ),
                          Effect.asVoid
                        )
                  }
                }))
              )
        })
      })
    ).pipe(Layer.provide(transport.layer))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* capture.segment(transport)
          yield* Deferred.await(accepted).pipe(Effect.timeout("2 seconds"))
          const pending = (yield* voice.snapshot(join.sessionId, 0)).pending[0]
          if (pending?.receipt == null) throw new Error("Expected durably accepted speech before ending the host")
          expect(yield* conversation.receipt(pending.deliveryId)).toEqual(pending.receipt)
          acceptedReceipt = pending.receipt
          association = {
            backendIncarnationId: pending.backendIncarnationId,
            sessionId: join.sessionId,
            deliveryId: pending.deliveryId
          }
          yield* voice.end(join.sessionId)
        })
      ).pipe(
        Effect.provide(
          voiceOutputLayer(
            database.path,
            { ...transport, layer: transportLayer },
            fakeSynthesisLayer(),
            fakeAnswerLayer(0),
            fakeRecognitionLayer(),
            defaultVoiceLanguageConfiguration,
            defaultVoiceOutputSettings,
            capture.layer
          )
        )
      )
    )
    const nextTransport = voiceTransportFixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const resolution = (yield* voice.resolve({ admissions: [association] })).admissions[0]
          expect(resolution?.status).toBe("Accepted")
          expect(resolution?.receipt).toEqual(acceptedReceipt)
          const before = (yield* conversation.page({ limit: 100 })).messages
          expect(before.filter((message) => message.role === "user")).toHaveLength(1)
          const join = yield* voice.start(startVoiceRequest())
          expect(join.backendIncarnationId).not.toBe(association.backendIncarnationId)
          expect((yield* voice.snapshot(join.sessionId, 0)).output).toBeNull()
          yield* voice.resolve({ admissions: [association] })
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual(before)
          expect(nextTransport.captured).toEqual([])
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, nextTransport)))
    )
  } finally {
    await database.close()
  }
})
it("bounds evidence, preserves Open associations, and treats evicted identities as Unknown", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const store = yield* VoiceAdmissions
      const sessionId = crypto.randomUUID()
      const entries: SpeechAdmission[] = Array.from({ length: 8 }, () => ({
        backendIncarnationId: store.backendIncarnationId,
        sessionId,
        deliveryId: crypto.randomUUID()
      }))
      for (const entry of entries) yield* store.begin({ ...entry, text: "Evidence capacity" })
      const extra = { backendIncarnationId: store.backendIncarnationId, sessionId, deliveryId: crypto.randomUUID() }
      expect((yield* Effect.flip(store.begin({ ...extra, text: "Extra speech" }))).code).toBe("Overloaded")
      const first = entries[0]
      if (first === undefined) throw new Error("Expected initial checkpoint")
      expect((yield* voice.resolve({ admissions: [first] })).admissions[0]?.status).toBe("Unknown")
      yield* store.seal(first)
      expect((yield* voice.resolve({ admissions: [first] })).admissions[0]?.status).toBe("NotAccepted")
      yield* store.begin({ ...extra, text: "Extra speech" })
      expect((yield* voice.resolve({ admissions: [first] })).admissions[0]?.status).toBe("Unknown")
      expect((yield* store.find(extra))?.state).toBe("Open")
      const last = entries[7]
      if (last === undefined) throw new Error("Expected retained checkpoint")
      yield* store.seal(last)
      expect(
        (yield* Effect.flip(store.begin({ ...extra, sessionId: crypto.randomUUID(), text: "Conflicting origin" }))).code
      ).toBe("StorageUnavailable")
      expect((yield* store.find(last))?.state).toBe("Sealed")
      expect((yield* store.find(extra))?.state).toBe("Open")
    })
  ))
it("releases the shared writer and active Voice resources on application shutdown", async () => {
  const database = await temporaryDatabase()
  const first = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          yield* voice.start(startVoiceRequest())
          yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "Survives host lifetime" })
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, first)))
    )
    expect(first.closed()).toBe(true)
    const second = voiceTransportFixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          expect((yield* conversation.page({ limit: 100 })).messages[0]?.text).toBe("Survives host lifetime")
          const joined = yield* voice.start(startVoiceRequest())
          expect((yield* voice.snapshot(joined.sessionId, 0)).output).toBeNull()
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, second)))
    )
    expect(second.closed()).toBe(true)
  } finally {
    await database.close()
  }
})
it("binds speech acceptance to its exact finalized payload across text identity reuse", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const store = yield* VoiceAdmissions
      const conversation = yield* Conversation
      const association = {
        backendIncarnationId: store.backendIncarnationId,
        sessionId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID()
      }
      yield* store.begin({ ...association, text: "Original finalized speech" })
      yield* conversation.send({ deliveryId: association.deliveryId, text: "Different direct text" })
      expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Unknown")
      expect(
        (yield* Effect.flip(
          conversation.send({ deliveryId: association.deliveryId, text: "Original finalized speech" })
        ))._tag
      ).toBe("DeliveryConflict")
      yield* store.seal(association)
      expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe("NotAccepted")
      const matched = { ...association, deliveryId: crypto.randomUUID() }
      yield* store.begin({ ...matched, text: "Identical finalized speech" })
      const receipt = yield* conversation.send({ deliveryId: matched.deliveryId, text: "Identical finalized speech" })
      expect((yield* voice.resolve({ admissions: [matched] })).admissions).toEqual([
        { ...matched, status: "Accepted", receipt }
      ])
      expect(yield* conversation.send({ deliveryId: matched.deliveryId, text: "Identical finalized speech" })).toEqual(
        receipt
      )
      expect(
        (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
      ).toHaveLength(2)
    })
  ))
it("validates checkpoint identities and rejects repeated or expired admission origins", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const store = yield* VoiceAdmissions
      const association = {
        backendIncarnationId: store.backendIncarnationId,
        sessionId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID()
      }
      expect((yield* Effect.flip(store.begin({ ...association, sessionId: "invalid", text: "Speech" }))).code).toBe(
        "InvalidInput"
      )
      expect((yield* Effect.flip(store.begin({ ...association, text: "" }))).code).toBe("InvalidInput")
      expect(
        (yield* Effect.flip(store.begin({ ...association, backendIncarnationId: crypto.randomUUID(), text: "Speech" })))
          .code
      ).toBe("InvalidInput")
      yield* store.begin({ ...association, sessionId: association.sessionId.toUpperCase(), text: "Speech" })
      expect((yield* Effect.flip(store.begin({ ...association, text: "Speech" }))).code).toBe("AdmissionConflict")
      yield* store.seal({ ...association, sessionId: crypto.randomUUID() })
      expect((yield* store.find(association))?.state).toBe("Open")
      yield* store.seal(association)
      expect((yield* store.find(association))?.state).toBe("Sealed")
    })
  ))
it("keeps distinct allowed UTF-16 speech payloads distinct during durable resolution", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const store = yield* VoiceAdmissions
      const voice = yield* Voice
      const conversation = yield* Conversation
      const association = {
        backendIncarnationId: store.backendIncarnationId,
        sessionId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID()
      }
      yield* store.begin({ ...association, text: "Speech\uD800" })
      yield* conversation.send({ deliveryId: association.deliveryId, text: "Speech\uD801" })
      yield* store.seal(association)
      expect((yield* voice.resolve({ admissions: [association] })).admissions).toEqual([
        { ...association, status: "NotAccepted", receipt: null }
      ])
    })
  ))
