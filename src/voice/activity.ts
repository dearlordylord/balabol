import { Context, Effect, Layer, Schema } from "effect"
import type { Scope } from "effect"
import type { VoiceFailed } from "./contracts.ts"
import { speechActivityModel, activityLayout } from "./activity-protocol.ts"
import { VoiceFrame, failed } from "./contracts.ts"

export const SpeechActivitySettings = Schema.Struct({
  provider: Schema.Literals(["fake", "silero"]),
  modelPath: Schema.NonEmptyString
})
export type SpeechActivitySettings = typeof SpeechActivitySettings.Type
export const ActivityWindow = Schema.Struct({
  samples: Schema.instanceOf(Int16Array).check(
    Schema.makeFilter((samples) => samples.length > 0 && samples.length <= speechActivityModel.windowSamples)
  ),
  speech: Schema.Boolean
})
export type ActivityWindow = typeof ActivityWindow.Type
export interface ActivityStream {
  readonly push: (frame: VoiceFrame) => Effect.Effect<readonly ActivityWindow[], VoiceFailed>
  readonly reset: () => void
}
/** One stream owns continuity and model state. Reset fences in-flight results on track/mute changes. */
export class SpeechActivity extends Context.Service<
  SpeechActivity,
  { readonly open: () => Effect.Effect<ActivityStream, VoiceFailed, Scope.Scope> }
>()("balabol/speech-activity") {}

const fixtureVoiceThreshold = 0.006
// Deterministic development fixture only. Real speech mode must inject Silero explicitly.
export const fakeSpeechActivityLayer = Layer.succeed(SpeechActivity, {
  open: () =>
    Effect.succeed({
      reset: () => {},
      push: (raw) =>
        Schema.decodeUnknownEffect(VoiceFrame)(raw).pipe(
          Effect.mapError(() => failed("InvalidAudio", "Invalid activity input frame")),
          Effect.map((frame) => [
            {
              samples: frame.data.slice(),
              speech:
                Math.sqrt(frame.data.reduce((total, sample) => total + sample * sample, 0) / frame.data.length) /
                  activityLayout.pcmScale >=
                fixtureVoiceThreshold
            }
          ])
        )
    })
})
