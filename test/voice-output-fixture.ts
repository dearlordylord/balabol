import { voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { Effect, Layer, Queue } from "effect"
import type { AnswerGeneration, AnswerFailed } from "../src/answer-generation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import {
  Voice,
  SpeechActivity,
  type VoiceFrame,
  fakeSpeechActivityLayer,
  VoiceOutputConfiguration,
  defaultVoiceOutputSettings,
  VoiceLanguageConfiguration,
  defaultVoiceLanguageConfiguration,
  type VoiceLanguageSettings,
  type VoiceFailed,
  type VoiceOutputSettings,
  type VoiceAdmissions
} from "../src/voice/index.ts"
import type { Conversation } from "../src/conversation/index.ts"
import type { SpeechRecognition, RecognitionFailed } from "../src/speech-recognition/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import type { SpeechSynthesis, SpeechSynthesisFailed } from "../src/speech-synthesis/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
const onsetFrames = 3
const silenceFrames = 50
const speechSample = 1200
/** Opt in when a test needs ordinary input, rather than queue-overload or late-frame behavior. */
export const classifiedVoiceInput = (base: Layer.Layer<SpeechActivity, VoiceFailed> = fakeSpeechActivityLayer) =>
  Effect.gen(function* () {
    const completed = yield* Queue.unbounded<void>()
    const layer = Layer.effect(
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
    ).pipe(Layer.provide(base))
    const send = (transport: ReturnType<typeof voiceTransportFixture>, frame: VoiceFrame, track?: string) =>
      transport.send(frame, track).pipe(Effect.andThen(Queue.take(completed)), Effect.timeout("2 seconds"))
    const segment = (transport: ReturnType<typeof voiceTransportFixture>) =>
      Effect.gen(function* () {
        for (let frame = 0; frame < onsetFrames; frame++) yield* send(transport, transport.audio(speechSample))
        for (let frame = 0; frame < silenceFrames; frame++) yield* send(transport, transport.audio(0))
      })
    return { layer, send, segment }
  })

export const voiceOutputLayer = (
  path: string,
  transport: ReturnType<typeof voiceTransportFixture>,
  synthesis: Layer.Layer<SpeechSynthesis, SpeechSynthesisFailed> = fakeSynthesisLayer(),
  answer: Layer.Layer<AnswerGeneration, AnswerFailed> = fakeAnswerLayer(0),
  recognition: Layer.Layer<SpeechRecognition, RecognitionFailed> = fakeRecognitionLayer(),
  settings: VoiceLanguageSettings = defaultVoiceLanguageConfiguration,
  outputSettings: VoiceOutputSettings = defaultVoiceOutputSettings,
  activity: Layer.Layer<SpeechActivity, VoiceFailed> = fakeSpeechActivityLayer
) => {
  const conversation = replyLayer(path, answer, { attachmentMillis: 10 })
  const admissions = voiceAdmissionsFixture().pipe(Layer.provide(conversation))
  const voice = Voice.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        activity,
        Layer.succeed(VoiceLanguageConfiguration, settings),
        Layer.succeed(VoiceOutputConfiguration, outputSettings)
      )
    ),
    Layer.provide(Layer.mergeAll(conversation, transport.layer, synthesis, recognition, admissions))
  )
  return Layer.mergeAll(voice, conversation, admissions)
}
export const withVoiceOutput = async (
  program: (
    transport: ReturnType<typeof voiceTransportFixture>
  ) => Effect.Effect<void, unknown, Voice | Conversation | VoiceAdmissions>,
  synthesis: Layer.Layer<SpeechSynthesis, SpeechSynthesisFailed> = fakeSynthesisLayer(),
  answer: Layer.Layer<AnswerGeneration, AnswerFailed> = fakeAnswerLayer(0),
  recognition: Layer.Layer<SpeechRecognition, RecognitionFailed> = fakeRecognitionLayer(),
  settings: VoiceLanguageSettings = defaultVoiceLanguageConfiguration,
  outputSettings: VoiceOutputSettings = defaultVoiceOutputSettings,
  activity: Layer.Layer<SpeechActivity, VoiceFailed> = fakeSpeechActivityLayer
) => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const application = voiceOutputLayer(
    database.path,
    transport,
    synthesis,
    answer,
    recognition,
    settings,
    outputSettings,
    activity
  )
  try {
    await Effect.runPromise(Effect.scoped(program(transport)).pipe(Effect.provide(application)))
  } finally {
    await database.close()
  }
}
export const outputInput = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Hello" }
const maximumPolls = 200
const pollMillis = 5
export const waitForOutput = (voice: Voice["Service"], sessionId: string, status: string) =>
  Effect.gen(function* () {
    let snapshot = yield* voice.snapshot(sessionId, 0)
    for (let attempt = 0; snapshot.output?.status !== status && attempt < maximumPolls; attempt++) {
      yield* Effect.sleep(pollMillis)
      snapshot = yield* voice.snapshot(sessionId, 0)
    }
    return snapshot
  })
