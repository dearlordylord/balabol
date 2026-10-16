import { Context, Effect, Layer, Schema, Option } from "effect"
import { Conversation } from "../conversation/index.ts"
import { SpeechRecognition } from "../speech-recognition/index.ts"
import { SpeechSynthesis } from "../speech-synthesis/index.ts"
import { VoiceTransport, OutputReady, OutputInterrupt, failed } from "./contracts.ts"
import type { VoiceJoin, VoiceSnapshot, VoiceFailed } from "./contracts.ts"
import { type StartVoiceRequest, type SpeechResolutions, ResolveSpeechAdmissions } from "./recovery-contracts.ts"
import { VoiceAdmissions, speechPayloadHash, speechAnnotationsHash, speechDetectionHash } from "./admissions.ts"
import { VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration, validateVoiceLanguages } from "./languages.ts"
import type { VoiceLanguageCapabilities } from "./languages.ts"
import { createVoiceSession } from "./session.ts"
import { makeVoiceRegistry } from "./registry-runtime.ts"
import { VoiceOutputSettings, VoiceOutputConfiguration, defaultVoiceOutputSettings } from "./output-configuration.ts"
import { SpeechActivity, fakeSpeechActivityLayer } from "./activity.ts"
import { VoiceDiagnostics, disabledVoiceDiagnostics } from "./diagnostics.ts"
export class Voice extends Context.Service<
  Voice,
  {
    languages: () => Effect.Effect<VoiceLanguageCapabilities>
    authorize: (id: string, token: string) => Effect.Effect<void, VoiceFailed>
    start: (request: StartVoiceRequest) => Effect.Effect<VoiceJoin, VoiceFailed>
    resolve: (request: ResolveSpeechAdmissions) => Effect.Effect<SpeechResolutions, VoiceFailed>
    snapshot: (id: string, after: number) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    mute: (id: string, muted: boolean) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    ready: (id: string, input: OutputReady) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    interrupt: (id: string, input: OutputInterrupt) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    end: (id: string) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  }
>()("balabol/voice") {
  static readonly configuredLayer = Layer.effect(
    Voice,
    Effect.gen(function* () {
      const diagnostics = Option.getOrElse(
        yield* Effect.serviceOption(VoiceDiagnostics),
        () => disabledVoiceDiagnostics
      )
      const languageSettings = yield* VoiceLanguageConfiguration
      const outputSettings = yield* Schema.decodeUnknownEffect(VoiceOutputSettings)(
        yield* VoiceOutputConfiguration
      ).pipe(Effect.mapError(() => failed("InvalidInput", "Invalid reply audio completion deadline")))
      const admissions = yield* VoiceAdmissions
      const conversation = yield* Conversation
      const provider = yield* SpeechRecognition
      const activity = yield* SpeechActivity
      const synthesis = yield* SpeechSynthesis
      const languages = yield* validateVoiceLanguages(
        languageSettings,
        provider.capabilities,
        synthesis.capabilities,
        conversation.replyLanguages
      )
      const transport = yield* VoiceTransport
      const scope = yield* Effect.scope
      const registry = yield* makeVoiceRegistry(
        createVoiceSession({
          conversation,
          provider,
          activity,
          synthesis,
          transport,
          admissions,
          languages,
          outputSettings,
          diagnostics,
          hostScope: scope
        }),
        scope
      )
      return Voice.of({
        languages: () => Effect.succeed(languages),
        authorize: (id, token) => registry.get(id).pipe(Effect.flatMap((session) => session.authorize(token))),
        start: registry.start,
        resolve: (raw) =>
          Schema.decodeUnknownEffect(ResolveSpeechAdmissions)(raw).pipe(
            Effect.mapError(() => failed("InvalidInput", "Invalid speech recovery identities")),
            Effect.flatMap((request) =>
              Effect.forEach(request.admissions, (association) =>
                admissions.find(association).pipe(
                  Effect.flatMap((checkpoint) => {
                    if (checkpoint === null)
                      return Effect.succeed({ ...association, status: "Unknown" as const, receipt: null })
                    return conversation
                      .receipt(association.deliveryId)
                      .pipe(
                        Effect.map((receipt) =>
                          receipt !== null &&
                          receipt.role === "user" &&
                          speechPayloadHash(receipt.text) === checkpoint.payloadHash &&
                          speechAnnotationsHash(receipt.languageSpans) === checkpoint.languageSpansHash &&
                          speechDetectionHash(receipt.detectedLanguage) === checkpoint.detectedLanguageHash
                            ? { ...association, status: "Accepted" as const, receipt }
                            : {
                                ...association,
                                status: checkpoint.state === "Sealed" ? ("NotAccepted" as const) : ("Unknown" as const),
                                receipt: null
                              }
                        )
                      )
                  }),
                  Effect.catch(() => Effect.succeed({ ...association, status: "Unknown" as const, receipt: null }))
                )
              ).pipe(Effect.map((results) => ({ admissions: results })))
            )
          ),
        snapshot: (id, after) => registry.get(id).pipe(Effect.flatMap((session) => session.snapshot(after))),
        mute: (id, muted) => registry.get(id).pipe(Effect.flatMap((session) => session.mute(muted))),
        ready: (id, raw) =>
          registry.get(id).pipe(
            Effect.flatMap((session) =>
              Schema.decodeUnknownEffect(OutputReady)(raw).pipe(
                Effect.mapError(() => failed("InvalidInput", "Invalid output readiness")),
                Effect.flatMap((input) => session.ready(input))
              )
            )
          ),
        interrupt: (id, raw) =>
          registry.get(id).pipe(
            Effect.flatMap((session) =>
              Schema.decodeUnknownEffect(OutputInterrupt)(raw).pipe(
                Effect.mapError(() => failed("InvalidInput", "Invalid output interruption")),
                Effect.flatMap((input) => session.interrupt(input))
              )
            )
          ),
        end: (id) => registry.get(id).pipe(Effect.flatMap((session) => session.end()))
      })
    })
  )
  static readonly layer = Voice.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeSpeechActivityLayer,
        Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
        Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings)
      )
    )
  )
}
