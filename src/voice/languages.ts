import { Context, Effect, Schema } from "effect"
import { LanguageTags } from "../language/index.ts"
import { RecognitionCapabilities } from "../speech-recognition/index.ts"
import { SynthesisCapabilities } from "../speech-synthesis/index.ts"
import { failed, VoiceFailed } from "./contracts.ts"
export const VoiceLanguageSettings = Schema.Struct({ allowedLanguages: LanguageTags })
export type VoiceLanguageSettings = typeof VoiceLanguageSettings.Type
export const defaultVoiceLanguageConfiguration: VoiceLanguageSettings = { allowedLanguages: ["ru", "fr", "en"] }
export class VoiceLanguageConfiguration extends Context.Service<VoiceLanguageConfiguration, VoiceLanguageSettings>()(
  "balabol/voice-language-configuration"
) {}
export const VoiceLanguageCapabilities = Schema.Struct({
  allowedLanguages: LanguageTags,
  supportedLanguages: LanguageTags
})
export type VoiceLanguageCapabilities = typeof VoiceLanguageCapabilities.Type
export const validateVoiceLanguages = (
  raw: VoiceLanguageSettings,
  recognition: RecognitionCapabilities,
  synthesis: SynthesisCapabilities,
  responseLanguages: readonly string[]
) =>
  Effect.gen(function* () {
    const settings = yield* Schema.decodeUnknownEffect(VoiceLanguageSettings)(raw)
    const input = yield* Schema.decodeUnknownEffect(RecognitionCapabilities)(recognition)
    const output = yield* Schema.decodeUnknownEffect(SynthesisCapabilities)(synthesis)
    const responses = yield* Schema.decodeUnknownEffect(LanguageTags)(responseLanguages)
    const supportedLanguages = input.languages.filter(
      (language) => output.languages.includes(language) && responses.includes(language)
    )
    const missing = settings.allowedLanguages.filter((language) => !supportedLanguages.includes(language))
    if (missing.length > 0)
      return yield* failed(
        "InvalidLanguageConfiguration",
        `Configured voice languages are unsupported by the selected providers: ${missing.join(", ")}`
      )
    if (!output.languages.includes("en") || !responses.includes("en"))
      return yield* failed("InvalidLanguageConfiguration", "Reply and synthesis must support fallback English")
    return yield* Schema.decodeUnknownEffect(VoiceLanguageCapabilities)({ ...settings, supportedLanguages })
  }).pipe(
    Effect.mapError((error) =>
      error instanceof VoiceFailed
        ? error
        : failed("InvalidLanguageConfiguration", "Unsupported or invalid voice language configuration")
    )
  )
