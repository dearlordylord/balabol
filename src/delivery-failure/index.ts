import { Schema } from "effect"
import { FailureDiagnostic } from "../failure-diagnostic/index.ts"

const maximumMessageLength = 1000
export const FailureReason = Schema.Literals([
  "UnsupportedLanguage",
  "UncertainLanguage",
  "MissingVoice",
  "InvalidSynthesisRequest",
  "SynthesisWriteFailed",
  "ReadinessDeadline",
  "DeliveryDeadline",
  "SynthesisPlanFailed",
  "SynthesisRenderFailed",
  "AudioConversionFailed",
  "SynthesisDeadline",
  "NativeProcessFailed",
  "InvalidAudio",
  "MediaUnavailable",
  "UnexpectedDefect",
  "ProviderFailure"
])
/** Safe delivery metadata, excluded from conversation text and model context. */
export const DeliveryFailure = Schema.Struct({
  code: Schema.Literals([
    "MemoryPending",
    "MemoryFailed",
    "ProviderFailed",
    "InvalidProviderStream",
    "StorageUnavailable",
    "Restarted",
    "Cancelled",
    "AudioUnavailable"
  ]),
  reason: Schema.optionalKey(FailureReason),
  diagnostic: Schema.optionalKey(FailureDiagnostic),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumMessageLength))
})
export type DeliveryFailure = typeof DeliveryFailure.Type

const failureFields: readonly (keyof DeliveryFailure)[] = ["code", "reason", "message"]
const sameDiagnostic = Schema.toEquivalence(Schema.optional(FailureDiagnostic))
export const sameDeliveryFailure = (left: DeliveryFailure | undefined, right: DeliveryFailure | undefined) =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      failureFields.every((key) => left[key] === right[key]) &&
      sameDiagnostic(left.diagnostic, right.diagnostic)
