import { Effect, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { RecognitionFailed, SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceDiagnostics } from "../src/voice/index.ts"
import type { VoiceDiagnosticInput } from "../src/voice/diagnostics.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, voiceOutputLayer } from "./voice-output-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"

it.each(["expected", "defect", "mixed"] as const)(
  "distinguishes %s recognition failure in diagnostics and accepts fresh speech afterward",
  async (mode) => {
    const database = await temporaryDatabase()
    const input = await Effect.runPromise(classifiedVoiceInput())
    const transport = voiceTransportFixture()
    const records: VoiceDiagnosticInput[] = []
    const observed = await Effect.runPromise(Queue.unbounded<void>())
    const recognition = Layer.effect(
      SpeechRecognition,
      Effect.gen(function* () {
        const real = yield* SpeechRecognition
        let attempt = 0
        return SpeechRecognition.of({
          ...real,
          recognize: (request) => {
            attempt += 1
            if (attempt !== 1) return real.recognize(request)
            const expected = Stream.fail(
              new RecognitionFailed({ message: "secret provider reason", reason: "Process" })
            )
            if (mode === "expected") return expected
            if (mode === "defect") return Stream.die("secret finalizer reason")
            return expected.pipe(Stream.ensuring(Effect.die("secret finalizer reason")))
          }
        })
      })
    ).pipe(
      Layer.provide(
        fakeRecognitionLayer({
          languages: ["ru", "fr", "en"],
          scripts: [{ events: [{ kind: "Final", text: "fresh", spans: [] }], delayMillis: 0, failure: null }]
        })
      )
    )
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
          record(record) {
            records.push(record)
            if (record.cause === "sessionError") Queue.offerUnsafe(observed, undefined)
          }
        })
      )
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* input.segment(transport)
          yield* Queue.take(observed).pipe(Effect.timeout("2 seconds"))
          const failed = yield* voice.snapshot(join.sessionId, 0)
          expect(failed.status).toBe("active")
          expect(failed.events.filter((event) => event.kind === "Error").map((event) => event.code)).toEqual([
            "RecognitionFailed"
          ])
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          expect(records.filter((record) => record.cause === "recognitionDefect")).toHaveLength(
            mode === "expected" ? 0 : 1
          )
          expect(records.find((record) => record.cause === "sessionError")?.recognitionReason).toBe(
            mode === "expected" ? "Process" : "Other"
          )
          expect(JSON.stringify(records)).not.toContain("secret")
          yield* input.segment(transport)
          let page = yield* conversation.page({ limit: 100 })
          for (let attempt = 0; !page.messages.some((message) => message.role === "user") && attempt < 200; attempt++) {
            yield* Effect.sleep(5)
            page = yield* conversation.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "fresh"
          ])
          yield* voice.end(join.sessionId)
        }).pipe(Effect.scoped, Effect.provide(application))
      )
    } finally {
      await database.close()
    }
  }
)
