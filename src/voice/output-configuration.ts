import { Context, Schema } from "effect"

/** Completion covers prior context, answer generation and playback; the control lease is independent. */
export const VoiceOutputSettings = Schema.Struct({
  completionMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300000 }))
})
export type VoiceOutputSettings = typeof VoiceOutputSettings.Type
export const defaultVoiceOutputSettings: VoiceOutputSettings = { completionMillis: 30000 }
export const realSpeechVoiceOutputSettings: VoiceOutputSettings = { completionMillis: 300000 }
export class VoiceOutputConfiguration extends Context.Service<VoiceOutputConfiguration, VoiceOutputSettings>()(
  "balabol/voice-output-configuration"
) {}
