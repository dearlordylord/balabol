import { Effect, Layer, Queue } from "effect"
import type { AnswerFailed, AnswerGeneration } from "../src/answer-generation/index.ts"
import type { Conversation } from "../src/conversation/index.ts"
import type { SpeechSynthesis, SpeechSynthesisFailed } from "../src/speech-synthesis/index.ts"
import { VoiceTransport, type Voice, type VoiceAdmissions, type VoiceOutput } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer } from "./voice-output-fixture.ts"

type OutputIdentity = { readonly responseId: string; readonly outputEpoch: string }
type AwaitOutput = (identity: OutputIdentity) => Effect.Effect<VoiceOutput>

/** Wait for the public terminal projection, independent of how many phrases precede it. */
export const withCompletedVoiceOutput = async (
  program: (
    transport: ReturnType<typeof voiceTransportFixture>,
    completed: AwaitOutput
  ) => Effect.Effect<void, unknown, Voice | Conversation | VoiceAdmissions>,
  synthesis: Layer.Layer<SpeechSynthesis, SpeechSynthesisFailed>,
  answer: Layer.Layer<AnswerGeneration, AnswerFailed>
) => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<VoiceOutput>()
        const layer = Layer.effect(
          VoiceTransport,
          Effect.gen(function* () {
            const real = yield* VoiceTransport
            return VoiceTransport.of({
              open: (...args) =>
                real
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
                              Effect.tap(() =>
                                event.kind === "Output" &&
                                ["Delivered", "Failed", "Interrupted"].includes(event.output.status)
                                  ? Queue.offer(outputs, event.output)
                                  : Effect.void
                              )
                            )
                      }
                    }))
                  )
            })
          })
        ).pipe(Layer.provide(transport.layer))
        const completed: AwaitOutput = (identity) =>
          Effect.gen(function* () {
            while (true) {
              const output = yield* Queue.take(outputs)
              if (output.responseId === identity.responseId && output.outputEpoch === identity.outputEpoch)
                return output
            }
          })
        yield* program(transport, completed).pipe(
          Effect.scoped,
          Effect.provide(voiceOutputLayer(database.path, { ...transport, layer }, synthesis, answer))
        )
      })
    )
  } finally {
    await database.close()
  }
}
