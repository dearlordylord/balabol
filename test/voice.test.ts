import { voiceAdmissionsFixture, startVoiceRequest } from "./voice-admission-fixture.ts"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Voice } from "../src/voice/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
const script = (text: string, delayMillis = 0) =>
  fakeRecognitionLayer({
    languages: ["ru", "fr", "en"],
    scripts: [
      {
        events: [
          { kind: "Interim", text: "tentative" },
          { kind: "Final", text, spans: [] }
        ],
        delayMillis,
        failure: null
      }
    ]
  })
const runVoice = async (
  program: (fixture: ReturnType<typeof voiceTransportFixture>) => Effect.Effect<void, unknown, Voice | Conversation>,
  provider = script("Bonjour")
) => {
  const database = await temporaryDatabase()
  const fixture = voiceTransportFixture()
  const conversation = replyLayer(database.path, fakeAnswerLayer())
  const voice = Voice.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        conversation,
        fixture.layer,
        provider,
        fakeSynthesisLayer(),
        voiceAdmissionsFixture().pipe(Layer.provide(conversation))
      )
    )
  )
  try {
    await Effect.runPromise(Effect.scoped(program(fixture)).pipe(Effect.provide(Layer.merge(voice, conversation))))
  } finally {
    await database.close()
  }
}
const settle = Effect.sleep(100)
describe("voice input uses the sole durable conversation", () => {
  it("keeps interim temporary and admits one complete identified final", () =>
    runVoice((fixture) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const joined = yield* voice.start(startVoiceRequest())
        yield* voice.authorize(joined.sessionId, joined.controlToken)
        expect((yield* Effect.flip(voice.authorize(joined.sessionId, "wrong"))).code).toBe("Unauthorized")
        expect((yield* Effect.flip(voice.start(startVoiceRequest()))).code).toBe("VoiceBusy")
        yield* fixture.segment
        yield* settle
        const snapshot = yield* voice.snapshot(joined.sessionId, 0)
        expect(snapshot.events.filter((event) => event.kind !== "Output").map((event) => event.kind)).toEqual([
          "Interim",
          "Final",
          "Accepted"
        ])
        const messages = (yield* conversation.page({ limit: 100 })).messages
        expect(messages[0]?.text).toBe("Bonjour")
        expect(snapshot.events.find((event) => event.kind === "Accepted")?.receipt).toEqual(messages[0])
        expect(JSON.stringify(snapshot)).not.toContain(joined.controlToken)
        yield* voice.end(joined.sessionId)
        expect(fixture.closed()).toBe(true)
      })
    ))
  it("does not admit silent or empty recognition and rejects malformed audio", () =>
    runVoice(
      (fixture) =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const joined = yield* voice.start(startVoiceRequest())
          yield* fixture.send(fixture.audio(0))
          yield* fixture.send({ ...fixture.audio(1000), channels: 2 })
          yield* fixture.segment
          yield* settle
          const discarded = (yield* voice.snapshot(joined.sessionId, 0)).events.filter(
            (event) => event.kind === "Interim" || event.kind === "Discarded"
          )
          expect(discarded.map((event) => event.kind)).toEqual(["Interim", "Discarded"])
          expect(discarded[0]?.utteranceId).toBe(discarded[1]?.utteranceId)
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          expect((yield* voice.snapshot(joined.sessionId, 0)).events.some((event) => event.kind === "Error")).toBe(true)
        }),
      script("   ")
    ))
  it("mute and end cancel unfinalized recognition and fence late audio", () =>
    runVoice(
      (fixture) =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const joined = yield* voice.start(startVoiceRequest())
          yield* fixture.segment
          yield* voice.mute(joined.sessionId, true)
          yield* fixture.segment
          yield* voice.end(joined.sessionId)
          yield* Effect.sleep(150)
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          expect((yield* voice.snapshot(joined.sessionId, 0)).status).toBe("ended")
          expect((yield* Effect.flip(voice.snapshot("invalid", 0))).code).toBe("InvalidSession")
        }),
      script("Canceled", 50)
    ))
})
it("bounds pending recognition and retains only two recent session controls", () =>
  runVoice(
    (fixture) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const first = yield* voice.start(startVoiceRequest())
        yield* fixture.segment
        yield* fixture.segment
        yield* fixture.segment
        const overloaded = yield* voice.snapshot(first.sessionId, 0)
        expect(overloaded.events.some((event) => event.kind === "Error" && event.code === "Overloaded")).toBe(true)
        yield* voice.end(first.sessionId)
        const second = yield* voice.start(startVoiceRequest())
        yield* voice.end(second.sessionId)
        const third = yield* voice.start(startVoiceRequest())
        expect(third.sessionId).not.toBe(first.sessionId)
        expect((yield* Effect.flip(voice.snapshot(first.sessionId, 0))).code).toBe("SessionNotFound")
        yield* voice.end(third.sessionId)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
      }),
    script("Pending", 1000)
  ))
it("reports deterministic recognition failures without saving an input", () =>
  runVoice(
    (fixture) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const session = yield* voice.start(startVoiceRequest())
        yield* fixture.segment
        yield* settle
        expect(
          (yield* voice.snapshot(session.sessionId, 0)).events.some(
            (event) => event.kind === "Error" && event.code === "RecognitionFailed"
          )
        ).toBe(true)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
      }),
    fakeRecognitionLayer({
      languages: ["ru", "fr", "en"],
      scripts: [{ events: [], delayMillis: 0, failure: "Fixture failure" }]
    })
  ))
