import { Schema } from "effect"
import { Message } from "../conversation/index.ts"
import { SessionId } from "./contracts.ts"
const maximumAdmissions = 2
export const StartVoiceRequest = Schema.Struct({ startRequestId: SessionId, muted: Schema.Boolean })
export type StartVoiceRequest = typeof StartVoiceRequest.Type
export const SpeechAdmission = Schema.Struct({
  backendIncarnationId: SessionId,
  sessionId: SessionId,
  deliveryId: SessionId
})
export type SpeechAdmission = typeof SpeechAdmission.Type
export const ResolveSpeechAdmissions = Schema.Struct({
  admissions: Schema.Array(SpeechAdmission).check(Schema.isMinLength(1), Schema.isMaxLength(maximumAdmissions))
}).check(
  Schema.makeFilter(
    (request) => new Set(request.admissions.map((value) => value.deliveryId)).size === request.admissions.length
  )
)
export type ResolveSpeechAdmissions = typeof ResolveSpeechAdmissions.Type
export const SpeechResolution = Schema.Union([
  Schema.Struct({ ...SpeechAdmission.fields, status: Schema.Literal("Accepted"), receipt: Message }).check(
    Schema.makeFilter((value) => value.receipt.deliveryId === value.deliveryId && value.receipt.role === "user")
  ),
  Schema.Struct({
    ...SpeechAdmission.fields,
    status: Schema.Literals(["NotAccepted", "Unknown"]),
    receipt: Schema.Null
  })
])
export type SpeechResolution = typeof SpeechResolution.Type
export const SpeechResolutions = Schema.Struct({
  admissions: Schema.Array(SpeechResolution).check(Schema.isMinLength(1), Schema.isMaxLength(maximumAdmissions))
}).check(
  Schema.makeFilter(
    (response) => new Set(response.admissions.map((value) => value.deliveryId)).size === response.admissions.length
  )
)
export type SpeechResolutions = typeof SpeechResolutions.Type
