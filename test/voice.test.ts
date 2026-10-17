import { voiceAdmissionsFixture, startVoiceRequest } from "./voice-admission-fixture.ts"
import { Effect, Layer, Queue } from "effect"
import { describe, expect, it } from "vitest"
import {
  Voice,
  SpeechActivity,
  fakeSpeechActivityLayer,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
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
const steadyFixture = Effect.gen(function* () {
  const fixture = voiceTransportFixture()
  const completed = yield* Queue.unbounded<void>()
  const activity = Layer.effect(
    SpeechActivity,
    Effect.gen(function* () {
      const real = yield* SpeechActivity
      return SpeechActivity.of({
        open: () =>
          real
            .open()
            .pipe(
              Effect.map((stream) => ({
                reset: () => stream.reset(),
                push: (frame) => stream.push(frame).pipe(Effect.tap(() => Queue.offer(completed, undefined)))
              }))
            )
      })
    })
  ).pipe(Layer.provide(fakeSpeechActivityLayer))
  const sendClassified = (sample: number, track?: string) =>
    fixture.send(fixture.audio(sample), track).pipe(Effect.andThen(Queue.take(completed)), Effect.timeout("2 seconds"))
  const classifiedSegment = Effect.gen(function* () {
    for (let frame = 0; frame < 3; frame++) yield* sendClassified(1200)
    for (let frame = 0; frame < 50; frame++) yield* sendClassified(0)
  })
  return { ...fixture, activity, sendClassified, classifiedSegment }
})
const runVoice = async (
  program: (fixture: Effect.Success<typeof steadyFixture>) => Effect.Effect<void, unknown, Voice | Conversation>,
  provider = script("Bonjour")
) => {
  const database = await temporaryDatabase()
  const fixture = await Effect.runPromise(steadyFixture)
  const conversation = replyLayer(database.path, fakeAnswerLayer())
  const voice = Voice.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fixture.activity,
        Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
        Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings)
      )
    ),
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
        yield* fixture.classifiedSegment
        let snapshot = yield* voice.snapshot(joined.sessionId, 0)
        for (let attempt = 0; !snapshot.events.some((event) => event.kind === "Accepted") && attempt < 200; attempt++) {
          yield* Effect.sleep(5)
          snapshot = yield* voice.snapshot(joined.sessionId, 0)
        }
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
          yield* fixture.sendClassified(0)
          yield* fixture.send({ ...fixture.audio(1000), channels: 2 })
          // Observe the capture reset before sending frames for the next valid turn.
          let invalid = yield* voice.snapshot(joined.sessionId, 0)
          for (let attempt = 0; !invalid.events.some((event) => event.kind === "Error") && attempt < 200; attempt++) {
            yield* Effect.sleep(5)
            invalid = yield* voice.snapshot(joined.sessionId, 0)
          }
          expect(invalid.events.filter((event) => event.kind === "Error").map((event) => event.code)).toEqual([
            "InvalidAudio"
          ])
          yield* fixture.classifiedSegment
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
          yield* fixture.classifiedSegment
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
it("queues recognition chunks without treating three pauses as overload and retains two recent session controls", () =>
  runVoice(
    (fixture) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const first = yield* voice.start(startVoiceRequest())
        yield* fixture.classifiedSegment
        yield* fixture.classifiedSegment
        yield* fixture.classifiedSegment
        const overloaded = yield* voice.snapshot(first.sessionId, 0)
        expect(overloaded.events.some((event) => event.kind === "Error")).toBe(false)
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
        yield* fixture.classifiedSegment
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

it("ignores isolated transients before admitting sustained speech without consuming recognition", () => {
  const received: { samples: number; prefix: number[] }[] = []
  const provider = Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const base = yield* SpeechRecognition
      return SpeechRecognition.of({
        ...base,
        recognize: (request) => {
          const data = new DataView(
            request.audio.bytes.buffer,
            request.audio.bytes.byteOffset,
            request.audio.bytes.byteLength
          )
          received.push({
            samples: request.audio.sampleFrames,
            prefix: [0, 320, 640].map((index) => data.getInt16(index * 2, true))
          })
          return base.recognize(request)
        }
      })
    })
  ).pipe(Layer.provide(script("Bonjour")))
  return runVoice(
    (fixture) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const joined = yield* voice.start(startVoiceRequest())
        yield* fixture.sendClassified(1200)
        for (let frame = 0; frame < 50; frame++) yield* fixture.sendClassified(0)
        for (let frame = 0; frame < 2; frame++) yield* fixture.sendClassified(1200)
        yield* fixture.sendClassified(0)
        yield* fixture.sendClassified(1200)
        for (let frame = 0; frame < 50; frame++) yield* fixture.sendClassified(0)
        yield* settle
        expect((yield* voice.snapshot(joined.sessionId, 0)).events).toEqual([])
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        expect(received).toEqual([])
        for (const sample of [1200, 1300, 1400]) yield* fixture.sendClassified(sample)
        for (let frame = 0; frame < 50; frame++) yield* fixture.sendClassified(0)
        yield* settle
        const snapshot = yield* voice.snapshot(joined.sessionId, 0)
        const accepted = snapshot.events.filter((event) => event.kind === "Accepted")
        expect(received).toEqual([{ samples: 16960, prefix: [1200, 1300, 1400] }])
        expect(accepted).toHaveLength(1)
        expect(accepted[0]?.receipt.text).toBe("Bonjour")
        expect((yield* conversation.page({ limit: 100 })).messages[0]).toEqual(accepted[0]?.receipt)
      }),
    provider
  )
})

it("clears tentative onset when microphone tracks, mute state or sessions change", () =>
  runVoice((fixture) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const first = yield* voice.start(startVoiceRequest())
      for (let frame = 0; frame < 2; frame++) yield* fixture.sendClassified(1200)
      yield* voice.mute(first.sessionId, true)
      yield* voice.mute(first.sessionId, false)
      yield* fixture.sendClassified(1200)
      for (let frame = 0; frame < 50; frame++) yield* fixture.sendClassified(0)
      for (let frame = 0; frame < 2; frame++) yield* fixture.sendClassified(1200)
      yield* fixture.sendClassified(1200, "replacement")
      for (let frame = 0; frame < 50; frame++) yield* fixture.sendClassified(0, "replacement")
      for (let frame = 0; frame < 2; frame++) yield* fixture.sendClassified(1200, "replacement")
      yield* voice.end(first.sessionId)
      const second = yield* voice.start(startVoiceRequest())
      yield* fixture.sendClassified(1200)
      for (let frame = 0; frame < 50; frame++) yield* fixture.sendClassified(0)
      yield* settle
      expect((yield* voice.snapshot(first.sessionId, 0)).pending).toEqual([])
      expect((yield* voice.snapshot(second.sessionId, 0)).events).toEqual([])
      expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
      yield* fixture.classifiedSegment
      yield* settle
      expect((yield* voice.snapshot(second.sessionId, 0)).events.some((event) => event.kind === "Accepted")).toBe(true)
    })
  ))
