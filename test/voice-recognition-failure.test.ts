import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import {
  SpeechRecognition,
  RecognitionFailed,
  fakeRecognitionLayer,
  qwenRecognitionLayer
} from "../src/speech-recognition/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceDiagnostics } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { classifiedVoiceInput, voiceOutputLayer, withVoiceOutput } from "./voice-output-fixture.ts"

it("rejects a successfully recognized prefix when a required suffix fails and recovers after quiet", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<Deferred.Deferred<string, RecognitionFailed>>()
        const succeeded = yield* Queue.unbounded<void>()
        const input = yield* classifiedVoiceInput()
        const transport = voiceTransportFixture()
        const recognition = Layer.effect(
          SpeechRecognition,
          Effect.gen(function* () {
            const real = yield* SpeechRecognition
            return SpeechRecognition.of({
              ...real,
              recognize: (request) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    const result = yield* Deferred.make<string, RecognitionFailed>()
                    yield* Queue.offer(requests, result)
                    return Stream.fromEffect(Deferred.await(result)).pipe(
                      Stream.map((text) => ({
                        kind: "Final" as const,
                        utteranceId: request.utteranceId,
                        text,
                        spans: [],
                        detectedLanguage: "en"
                      }))
                    )
                  })
                )
            })
          })
        ).pipe(Layer.provide(fakeRecognitionLayer()))
        const application = voiceOutputLayer(
          database.path,
          transport,
          fakeSynthesisLayer(),
          fakeAnswerLayer(0),
          recognition,
          undefined,
          undefined,
          input.layer
        ).pipe(
          Layer.provide(
            Layer.succeed(VoiceDiagnostics, {
              record: (event) => {
                if (event.cause === "recognitionSucceeded") Queue.offerUnsafe(succeeded, undefined)
              }
            })
          )
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* input.segment(transport)
          const first = yield* Queue.take(requests).pipe(Effect.timeout("2 seconds"))
          for (let frame = 0; frame < 500; frame++) yield* input.send(transport, transport.audio(1200))
          const second = yield* Queue.take(requests).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.succeed(first, "Never admit this prefix")
          yield* Queue.take(succeeded).pipe(Effect.timeout("2 seconds"))
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          yield* Deferred.fail(second, new RecognitionFailed({ message: "Required suffix failed" }))
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (let poll = 0; !snapshot.events.some((event) => event.kind === "Error") && poll < 200; poll++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.filter((event) => event.kind === "Error").map((event) => event.code)).toEqual([
            "RecognitionFailed"
          ])
          for (let frame = 0; frame < 10; frame++) yield* input.send(transport, transport.audio(1200))
          for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          expect(snapshot.events.some((event) => event.kind === "Final" || event.kind === "Accepted")).toBe(false)
          yield* input.segment(transport)
          const fresh = yield* Queue.take(requests).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.succeed(fresh, "Fresh complete turn")
          let page = yield* conversation.page({ limit: 100 })
          for (let poll = 0; !page.messages.some((message) => message.role === "user") && poll < 200; poll++) {
            yield* Effect.sleep(5)
            page = yield* conversation.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "Fresh complete turn"
          ])
          yield* voice.end(join.sessionId)
        }).pipe(Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})

for (const terminal of ["stream error", "malformed late packet"] as const)
  it(`rejects a candidate Final followed by ${terminal} and accepts the next complete turn`, async () => {
    const input = await Effect.runPromise(classifiedVoiceInput())
    let calls = 0
    const recognition = Layer.effect(
      SpeechRecognition,
      Effect.gen(function* () {
        const real = yield* SpeechRecognition
        return SpeechRecognition.of({
          ...real,
          recognize: (request) => {
            calls += 1
            const final = {
              kind: "Final" as const,
              utteranceId: request.utteranceId,
              text: calls === 1 ? "Uncommitted candidate" : "Clean EOF",
              spans: []
            }
            if (calls > 1) return Stream.succeed(final)
            return terminal === "stream error"
              ? Stream.concat(
                  Stream.succeed(final),
                  Stream.fail(new RecognitionFailed({ message: "Failure after candidate" }))
                )
              : Stream.make(final, { ...final, spans: [{ language: "en", start: 0, end: 1000 }] })
          }
        })
      })
    ).pipe(Layer.provide(fakeRecognitionLayer()))
    await withVoiceOutput(
      (transport) =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* input.segment(transport)
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (let poll = 0; !snapshot.events.some((event) => event.kind === "Error") && poll < 200; poll++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.filter((event) => event.kind === "Error").map((event) => event.code)).toEqual([
            terminal === "stream error" ? "RecognitionFailed" : "InvalidRecognition"
          ])
          expect(snapshot.events.some((event) => event.kind === "Final" || event.kind === "Accepted")).toBe(false)
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          yield* input.segment(transport)
          let page = yield* conversation.page({ limit: 100 })
          for (let poll = 0; !page.messages.some((message) => message.role === "user") && poll < 200; poll++) {
            yield* Effect.sleep(5)
            page = yield* conversation.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "Clean EOF"
          ])
          expect(calls).toBe(2)
          yield* voice.end(join.sessionId)
        }),
      fakeSynthesisLayer(),
      fakeAnswerLayer(0),
      recognition,
      undefined,
      undefined,
      input.layer
    )
  })

it("does not admit malformed native recognition and keeps listening for a valid phrase", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  let calls = 0
  const recognition = qwenRecognitionLayer(
    { provider: "qwen3-asr", helperPath: "fixture.py", executable: "fixture", modelPath: "fixture.bin" },
    {
      prepare: () => Effect.void,
      transcribe: () =>
        Effect.sync(() => {
          calls++
          return calls === 1
            ? "not-json"
            : JSON.stringify({ language: "fr", text: "Bonjour, je voudrais apprendre le français. Привет." })
        })
    }
  )
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* input.segment(transport)
        let snapshot = yield* voice.snapshot(join.sessionId, 0)
        for (let poll = 0; !snapshot.events.some((event) => event.kind === "Error") && poll < 200; poll++) {
          yield* Effect.sleep(5)
          snapshot = yield* voice.snapshot(join.sessionId, 0)
        }
        expect(snapshot.events.some((event) => event.kind === "Error" && event.code === "RecognitionFailed")).toBe(true)
        expect(snapshot.events.some((event) => event.kind === "Final" || event.kind === "Accepted")).toBe(false)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        expect(snapshot.status).toBe("active")
        yield* input.segment(transport)
        let page = yield* conversation.page({ limit: 100 })
        for (let poll = 0; !page.messages.some((message) => message.role === "user") && poll < 200; poll++) {
          yield* Effect.sleep(5)
          page = yield* conversation.page({ limit: 100 })
        }
        expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
          "Bonjour, je voudrais apprendre le français. Привет."
        ])
        expect(calls).toBe(2)
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    fakeAnswerLayer(0),
    recognition,
    undefined,
    undefined,
    input.layer
  )
})
