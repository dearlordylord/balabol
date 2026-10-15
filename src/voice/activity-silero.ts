import { Effect, Layer, Schema } from "effect"
import { SpeechActivity, type ActivityStream, type ActivityWindow } from "./activity.ts"
import { VoiceFrame, failed } from "./contracts.ts"
import { activityLayout } from "./activity-protocol.ts"
import { sileroRuntime, speechActivityModel } from "./activity-runtime.ts"
import type { ActivityModelRunner, ActivityRuntime } from "./activity-runtime.ts"
const Settings = Schema.Struct({ modelPath: Schema.NonEmptyString })
const State = Schema.instanceOf(Float32Array).check(
  Schema.makeFilter((data) => data.length === activityLayout.stateValues && data.every(Number.isFinite))
)
const Result = Schema.Struct({
  probability: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  state: State
})
const maximumInferenceMillis = 12000
const stream = (runner: ActivityModelRunner) =>
  Effect.gen(function* () {
    let busy = false
    let closed = false
    let generation = 0
    let samples = new Int16Array(0)
    let context = new Float32Array(speechActivityModel.contextSamples)
    let state = new Float32Array(activityLayout.stateValues)
    const reset = () => {
      generation += 1
      samples = new Int16Array(0)
      context = new Float32Array(speechActivityModel.contextSamples)
      state = new Float32Array(activityLayout.stateValues)
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        reset()
      })
    )
    const push: ActivityStream["push"] = (raw) =>
      Effect.suspend(() => {
        if (closed || busy)
          return Effect.fail(failed("ActivityUnavailable", "Speech activity stream is closed or busy"))
        busy = true
        return Effect.gen(function* () {
          const current = generation
          const frame = yield* Schema.decodeUnknownEffect(VoiceFrame)(raw).pipe(
            Effect.mapError(() => failed("InvalidAudio", "Invalid activity input frame"))
          )
          const combined = new Int16Array(samples.length + frame.data.length)
          combined.set(samples)
          combined.set(frame.data, samples.length)
          samples = combined
          const windows: ActivityWindow[] = []
          while (samples.length >= speechActivityModel.windowSamples) {
            const audio = samples.slice(0, speechActivityModel.windowSamples)
            samples = samples.slice(speechActivityModel.windowSamples)
            const input = new Float32Array(speechActivityModel.windowSamples + speechActivityModel.contextSamples)
            input.set(context)
            for (let index = 0; index < audio.length; index++)
              input[speechActivityModel.contextSamples + index] = (audio[index] ?? 0) / activityLayout.pcmScale
            const result = yield* Effect.tryPromise({
              try: (signal) => runner.run(input, state, signal),
              catch: () => failed("ActivityUnavailable", "Speech activity inference failed")
            }).pipe(
              Effect.timeout(maximumInferenceMillis),
              Effect.mapError(() => failed("ActivityUnavailable", "Speech activity inference failed or timed out")),
              Effect.flatMap(Schema.decodeUnknownEffect(Result)),
              Effect.mapError(() => failed("ActivityUnavailable", "Invalid speech activity inference result"))
            )
            if (generation !== current) return []
            state = result.state
            context = input.slice(-speechActivityModel.contextSamples)
            windows.push({ samples: audio, speech: result.probability >= speechActivityModel.speechThreshold })
          }
          return windows
        }).pipe(
          Effect.onError(() => Effect.sync(reset)),
          Effect.ensuring(
            Effect.sync(() => {
              busy = false
            })
          )
        )
      })
    return { push, reset }
  })
export const sileroSpeechActivityLayer = (settings: typeof Settings.Type, runtime: ActivityRuntime = sileroRuntime) =>
  Layer.effect(
    SpeechActivity,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(Settings)(settings).pipe(
        Effect.mapError(() => failed("ActivityUnavailable", "Invalid speech activity settings"))
      )
      const runner = yield* runtime.open(config.modelPath)
      return SpeechActivity.of({ open: () => stream(runner) })
    })
  )
