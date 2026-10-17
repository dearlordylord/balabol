import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechRecognition, RecognitionFailed, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, withVoiceOutput } from "./voice-output-fixture.ts"

for (const retirement of ["track", "end"] as const)
  it(`fences late recognition success and failure after ${retirement} retirement and accepts fresh speech`, async () => {
    const input = await Effect.runPromise(classifiedVoiceInput())
    const requests = await Effect.runPromise(Queue.unbounded<Deferred.Deferred<string, RecognitionFailed>>())
    const finished = await Effect.runPromise(Queue.unbounded<void>())
    const held: Deferred.Deferred<string, RecognitionFailed>[] = []
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
                held.push(result)
                yield* Queue.offer(requests, result)
                return Stream.fromEffect(Deferred.await(result).pipe(Effect.uninterruptible)).pipe(
                  Stream.map((text) => ({
                    kind: "Final" as const,
                    utteranceId: request.utteranceId,
                    text,
                    spans: [],
                    detectedLanguage: "en"
                  })),
                  Stream.ensuring(Queue.offer(finished, undefined))
                )
              })
            )
        })
      })
    ).pipe(Layer.provide(fakeRecognitionLayer()))
    await withVoiceOutput(
      (transport) =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* Effect.gen(function* () {
            yield* input.segment(transport)
            const first = yield* Queue.take(requests).pipe(Effect.timeout("2 seconds"))
            yield* input.segment(transport)
            const second = yield* Queue.take(requests).pipe(Effect.timeout("2 seconds"))
            let ending: Fiber.Fiber<void, unknown> | undefined
            if (retirement === "end") {
              ending = yield* voice.end(join.sessionId).pipe(Effect.asVoid, Effect.forkIn(yield* Effect.scope))
              yield* Effect.gen(function* () {
                while ((yield* voice.snapshot(join.sessionId, 0)).status !== "ended") yield* Effect.yieldNow
              }).pipe(Effect.timeout("2 seconds"))
              expect(ending.pollUnsafe()).toBeUndefined()
            } else {
              yield* input.send(transport, transport.audio(1300), "replacement")
            }
            yield* Deferred.succeed(first, "Retired successful prefix")
            yield* Deferred.fail(second, new RecognitionFailed({ message: "Retired failure" }))
            yield* Queue.take(finished).pipe(Effect.timeout("2 seconds"))
            yield* Queue.take(finished).pipe(Effect.timeout("2 seconds"))
            if (ending) yield* Fiber.join(ending)
            const current = retirement === "end" ? yield* voice.start(startVoiceRequest()) : join
            const track = retirement === "end" ? "microphone" : "replacement"
            // Replacement already supplied one fresh onset frame above.
            for (let frame = 0; frame < (retirement === "end" ? 3 : 2); frame++)
              yield* input.send(transport, transport.audio(1400), track)
            for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0), track)
            const fresh = yield* Queue.take(requests).pipe(Effect.timeout("2 seconds"))
            yield* Deferred.succeed(fresh, "Fresh after retirement")
            let page = yield* conversation.page({ limit: 100 })
            for (let poll = 0; !page.messages.some((message) => message.role === "user") && poll < 200; poll++) {
              yield* Effect.sleep(5)
              page = yield* conversation.page({ limit: 100 })
            }
            expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
              "Fresh after retirement"
            ])
            const old = yield* voice.snapshot(join.sessionId, 0)
            expect(old.events.some((event) => event.kind === "Error")).toBe(false)
            expect(old.events.filter((event) => event.kind === "Final").map((event) => event.text)).toEqual(
              retirement === "end" ? [] : ["Fresh after retirement"]
            )
            yield* voice.end(current.sessionId)
          }).pipe(Effect.ensuring(Effect.forEach(held, (gate) => Deferred.succeed(gate, "Cleanup"), { discard: true })))
        }).pipe(Effect.scoped),
      fakeSynthesisLayer(),
      fakeAnswerLayer(0),
      recognition,
      undefined,
      undefined,
      input.layer
    )
  })
