import { Context, Schema, SchemaGetter } from "effect"
import type { SynthesisAudio } from "../speech-synthesis/index.ts"
import type { Effect } from "effect"
import { LanguageTag, LanguageSpans, validLanguageSpans } from "../language/index.ts"
import { Message } from "../conversation/index.ts"
const maximumTrackSid = 128
const outputSampleRate = 24000
const maximumErrorCode = 100
const maximumErrorMessage = 1000
const maximumText = 100000
const maximumPending = 2
const sampleRate = 16000
const frameSamples = 320
const Id = Schema.String.check(Schema.isUUID()).pipe(
  Schema.decodeTo(Schema.String.check(Schema.isUUID(), Schema.isLowercased()), {
    decode: SchemaGetter.transform((id) => id.toLowerCase()),
    encode: SchemaGetter.passthrough()
  })
)
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const base = { sequence: Sequence, sessionId: Id }
const utterance = { ...base, utteranceId: Id }
export const AudioManifest = Schema.Struct({
  sessionId: Id,
  responseId: Id,
  inputDeliveryId: Id,
  outputEpoch: Id,
  publisherIdentity: Id,
  trackSid: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumTrackSid)),
  sourceAudio: Schema.Struct({
    encoding: Schema.Literal("pcm-s16le"),
    sampleRateHz: Schema.Literal(outputSampleRate),
    channels: Schema.Literal(1)
  })
})
export type AudioManifest = typeof AudioManifest.Type
const outputFields = { responseId: Id, inputDeliveryId: Id, outputEpoch: Id }
const AudioError = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumErrorCode)),
  message: Schema.String.check(Schema.isMaxLength(maximumErrorMessage))
})
export const VoiceOutput = Schema.Union([
  Schema.Struct({ ...outputFields, status: Schema.Literal("Preparing"), manifest: Schema.Null, error: Schema.Null }),
  Schema.Struct({
    ...outputFields,
    status: Schema.Literals(["AwaitingReady", "Playing", "Delivered"]),
    manifest: AudioManifest,
    error: Schema.Null
  }),
  Schema.Struct({
    ...outputFields,
    status: Schema.Literal("Interrupted"),
    manifest: Schema.NullOr(AudioManifest),
    error: Schema.Null
  }),
  Schema.Struct({
    ...outputFields,
    status: Schema.Literal("Failed"),
    manifest: Schema.NullOr(AudioManifest),
    error: AudioError
  })
]).check(
  Schema.makeFilter(
    (output) =>
      output.responseId !== output.inputDeliveryId &&
      (output.manifest === null ||
        (output.manifest.responseId === output.responseId &&
          output.manifest.inputDeliveryId === output.inputDeliveryId &&
          output.manifest.outputEpoch === output.outputEpoch))
  )
)
export type VoiceOutput = typeof VoiceOutput.Type
export const OutputReady = Schema.Struct({ responseId: Id, outputEpoch: Id, trackSid: AudioManifest.fields.trackSid })
export type OutputReady = typeof OutputReady.Type
export const OutputInterrupt = Schema.Struct({ ...outputFields })
export type OutputInterrupt = typeof OutputInterrupt.Type
export const VoiceEvent = Schema.Union([
  Schema.Struct({ ...base, kind: Schema.Literal("Output"), output: VoiceOutput }).check(
    Schema.makeFilter((event) => event.output.manifest === null || event.output.manifest.sessionId === event.sessionId)
  ),
  Schema.Struct({ ...utterance, kind: Schema.Literal("Interim"), text: Schema.String }),
  Schema.Struct({
    ...utterance,
    kind: Schema.Literal("Final"),
    backendIncarnationId: Id,
    deliveryId: Id,
    text: Schema.String,
    languageSpans: LanguageSpans,
    detectedLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag))
  }).check(
    Schema.makeFilter(
      (event) => event.deliveryId === event.utteranceId && validLanguageSpans(event.text, event.languageSpans)
    )
  ),
  Schema.Struct({ ...utterance, kind: Schema.Literal("Accepted"), receipt: Message }).check(
    Schema.makeFilter((event) => event.receipt.deliveryId === event.utteranceId && event.receipt.role === "user")
  ),
  Schema.Struct({ ...utterance, kind: Schema.Literal("Discarded"), reason: Schema.Literal("Empty") }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("Error"),
    utteranceId: Schema.NullOr(Id),
    code: Schema.String,
    message: Schema.String
  }),
  Schema.Struct({ ...base, kind: Schema.Literal("Muted"), muted: Schema.Boolean }),
  Schema.Struct({ ...base, kind: Schema.Literal("Ended") })
])
export type VoiceEvent = typeof VoiceEvent.Type
export const sameDetectedLanguage = (left: string | null | undefined, right: string | null | undefined) =>
  (left ?? null) === (right ?? null)
const matchingPendingReceipt = (input: {
  receipt: typeof Message.Type | null
  deliveryId: string
  text: string
  detectedLanguage?: string | null
  languageSpans: typeof LanguageSpans.Type
}) => {
  const receipt = input.receipt
  return (
    receipt === null ||
    (receipt.deliveryId === input.deliveryId &&
      receipt.text === input.text &&
      sameDetectedLanguage(receipt.detectedLanguage, input.detectedLanguage) &&
      JSON.stringify(receipt.languageSpans) === JSON.stringify(input.languageSpans) &&
      receipt.role === "user")
  )
}
export const PendingVoiceInput = Schema.Struct({
  backendIncarnationId: Id,
  languageSpans: LanguageSpans,
  detectedLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag)),
  utteranceId: Id,
  deliveryId: Id,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumText)),
  receipt: Schema.NullOr(Message),
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String }))
}).check(
  Schema.makeFilter(
    (input) =>
      input.utteranceId === input.deliveryId &&
      validLanguageSpans(input.text, input.languageSpans) &&
      matchingPendingReceipt(input)
  )
)
export type PendingVoiceInput = typeof PendingVoiceInput.Type
export const VoiceSnapshot = Schema.Struct({
  backendIncarnationId: Id,
  controlDeadlineAt: Schema.Number,
  sessionId: Id,
  status: Schema.Literals(["active", "ended"]),
  muted: Schema.Boolean,
  sequence: Sequence,
  events: Schema.Array(VoiceEvent),
  firstSequence: Sequence,
  audioFramesReceived: Sequence,
  sampleFramesReceived: Sequence,
  output: Schema.NullOr(VoiceOutput),
  pending: Schema.Array(PendingVoiceInput).check(Schema.isMaxLength(maximumPending)),
  nextAfter: Sequence
}).check(
  Schema.makeFilter(function validSnapshot(snapshot) {
    return (
      (snapshot.output?.manifest == null || snapshot.output.manifest.sessionId === snapshot.sessionId) &&
      snapshot.pending.every(function sameIncarnation(input) {
        return input.backendIncarnationId === snapshot.backendIncarnationId
      }) &&
      snapshot.events.every(function sameSession(event) {
        return (
          event.sessionId === snapshot.sessionId &&
          (event.kind !== "Final" || event.backendIncarnationId === snapshot.backendIncarnationId)
        )
      })
    )
  })
)
export type VoiceSnapshot = typeof VoiceSnapshot.Type
export const VoiceJoin = Schema.Struct({
  backendIncarnationId: Id,
  startRequestId: Id,
  joinDeadlineAt: Schema.Number,
  controlDeadlineAt: Schema.Number,
  sessionId: Id,
  roomName: Id,
  participantIdentity: Id,
  backendParticipantIdentity: Id,
  mediaUrl: Schema.String,
  token: Schema.String,
  controlToken: Schema.String,
  expiresAt: Schema.Number
})
export type VoiceJoin = typeof VoiceJoin.Type
export const VoiceErrorResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumErrorCode)),
    message: Schema.String.check(Schema.isMaxLength(maximumErrorMessage))
  })
})
export class VoiceFailed extends Schema.TaggedError<VoiceFailed>()("VoiceFailed", {
  code: Schema.String,
  message: Schema.String
}) {}
export const failed = (code: string, message: string) => new VoiceFailed({ code, message })
export const VoiceFrame = Schema.Struct({
  sampleRate: Schema.Literal(sampleRate),
  channels: Schema.Literal(1),
  samplesPerChannel: Schema.Literal(frameSamples),
  data: Schema.instanceOf(Int16Array)
}).check(Schema.makeFilter((frame) => frame.data.length === frameSamples))
export type VoiceFrame = typeof VoiceFrame.Type
export interface AudioPublication {
  publisherIdentity: string
  trackSid: string
  capture: (audio: SynthesisAudio) => Effect.Effect<void, VoiceFailed>
  drain: () => Effect.Effect<void, VoiceFailed>
  invalidate: () => void
  close: () => Effect.Effect<void>
}
export interface MediaConnection {
  openOutput: (outputEpoch: string) => Effect.Effect<AudioPublication, VoiceFailed>
  close: () => Effect.Effect<void>
  publish: (event: VoiceEvent) => Effect.Effect<void, VoiceFailed>
}
export class VoiceTransport extends Context.Service<
  VoiceTransport,
  {
    open: (
      identity: { sessionId: string; roomName: string; participantIdentity: string },
      frame: (track: string, frame: unknown) => void,
      disconnected: () => void,
      connected: () => void
    ) => Effect.Effect<
      {
        join: Omit<
          VoiceJoin,
          "controlToken" | "backendIncarnationId" | "startRequestId" | "joinDeadlineAt" | "controlDeadlineAt"
        >
        connection: MediaConnection
      },
      VoiceFailed
    >
  }
>()("balabol/voice-transport") {}
export const SessionId = Id
export const MuteRequest = Schema.Struct({ muted: Schema.Boolean })
