import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { Voice } from "../src/voice/index.ts"
import { SpeechSynthesis, SpeechSynthesisFailed, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { withVoiceOutput, voiceOutputLayer, outputInput, waitForOutput } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

const failedReply = (acknowledge = true) =>
  Effect.gen(function* () {
    const voice = yield* Voice
    const conversation = yield* Conversation
    const join = yield* voice.start(startVoiceRequest())
    yield* conversation.send(outputInput)
    const preparing = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
    const output = preparing.output
    if (output?.manifest == null) throw new Error("Missing publication")
    if (acknowledge)
      yield* voice.ready(join.sessionId, {
        responseId: output.responseId,
        outputEpoch: output.outputEpoch,
        trackSid: output.manifest.trackSid
      })
    if (!acknowledge) yield* Effect.sleep(5100)
    const failed = yield* waitForOutput(voice, join.sessionId, "Failed")
    expect(failed.output?.error).not.toBeNull()
    let reply = yield* conversation.reply(outputInput.deliveryId)
    for (let attempt = 0; reply.receipt === null && attempt < 200; attempt++) {
      yield* Effect.sleep(5)
      reply = yield* conversation.reply(outputInput.deliveryId)
    }
    expect(reply.receipt).not.toBeNull()
    expect(reply.state).toBe("Failed")
    expect(reply.error).toEqual(failed.output?.error)
    return reply
  })
it("preserves an audio failure after durable settlement instead of reporting a user interruption", () =>
  withVoiceOutput(() => failedReply().pipe(Effect.asVoid), fakeSynthesisLayer({ failureAfterChunks: 0 })))
it("restores the original delivery failure from real SQLite after backend restart", async () => {
  const database = await temporaryDatabase()
  try {
    const original = await Effect.runPromise(
      Effect.scoped(failedReply()).pipe(
        Effect.provide(
          voiceOutputLayer(database.path, voiceTransportFixture(), fakeSynthesisLayer({ failureAfterChunks: 0 }))
        )
      )
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const restored = yield* conversation.reply(outputInput.deliveryId)
          expect(restored.state).toBe("Failed")
          expect(restored.error).toEqual(original.error)
          expect(restored.receipt).toEqual(original.receipt)
          expect((yield* conversation.olderPage({ limit: 10 })).messages[1]?.failure).toEqual(original.error)
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
  } finally {
    await database.close()
  }
})

it("reports a readiness deadline as a durable delivery failure with an explicit reason", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const reply = yield* failedReply(false)
      expect(reply.error?.reason).toBe("ReadinessDeadline")
    })
  ))
it("normalizes a long provider error once and retains the same cause through invalidation and persistence", () => {
  const synthesis = Layer.effect(
    SpeechSynthesis,
    Effect.map(SpeechSynthesis, (real) => ({
      ...real,
      synthesize: () =>
        Stream.fail(new SpeechSynthesisFailed({ message: "x".repeat(1200), reason: "SynthesisRenderFailed" }))
    }))
  ).pipe(Layer.provide(fakeSynthesisLayer()))
  return withVoiceOutput(
    () =>
      Effect.gen(function* () {
        const reply = yield* failedReply()
        expect(reply.error?.message).toHaveLength(1000)
        expect(reply.error?.reason).toBe("SynthesisRenderFailed")
      }),
    synthesis
  )
})
