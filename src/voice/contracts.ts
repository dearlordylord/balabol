import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Message } from "../conversation/index.ts"
const maximumErrorCode = 100
const maximumErrorMessage = 1000
const maximumText = 100000
const maximumPending = 2
const sampleRate = 16000
const frameSamples = 320
const Id = Schema.String.check(Schema.isUUID())
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const base = { sequence: Sequence, sessionId: Id }
const utterance = { ...base, utteranceId: Id }
export const VoiceEvent = Schema.Union([
  Schema.Struct({ ...utterance, kind: Schema.Literal("Interim"), text: Schema.String }),
  Schema.Struct({ ...utterance, kind: Schema.Literal("Final"), deliveryId: Id, text: Schema.String }).check(
    Schema.makeFilter((event) => event.deliveryId === event.utteranceId)
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
export const PendingVoiceInput = Schema.Struct({
  utteranceId: Id,
  deliveryId: Id,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumText)),
  receipt: Schema.NullOr(Message),
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String }))
}).check(
  Schema.makeFilter(
    (input) =>
      input.utteranceId === input.deliveryId &&
      (input.receipt === null ||
        (input.receipt.deliveryId === input.deliveryId &&
          input.receipt.text === input.text &&
          input.receipt.role === "user"))
  )
)
export type PendingVoiceInput = typeof PendingVoiceInput.Type
export const VoiceSnapshot = Schema.Struct({
  sessionId: Id,
  status: Schema.Literals(["active", "ended"]),
  muted: Schema.Boolean,
  sequence: Sequence,
  events: Schema.Array(VoiceEvent),
  firstSequence: Sequence,
  audioFramesReceived: Sequence,
  sampleFramesReceived: Sequence,
  pending: Schema.Array(PendingVoiceInput).check(Schema.isMaxLength(maximumPending)),
  nextAfter: Sequence
})
export type VoiceSnapshot = typeof VoiceSnapshot.Type
export const VoiceJoin = Schema.Struct({
  sessionId: Id,
  roomName: Id,
  participantIdentity: Id,
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
export interface MediaConnection {
  close: () => Effect.Effect<void>
  publish: (event: VoiceEvent) => Effect.Effect<void, VoiceFailed>
}
export class VoiceTransport extends Context.Service<
  VoiceTransport,
  {
    open: (
      identity: { sessionId: string; roomName: string; participantIdentity: string },
      frame: (track: string, frame: unknown) => void,
      disconnected: () => void
    ) => Effect.Effect<{ join: Omit<VoiceJoin, "controlToken">; connection: MediaConnection }, VoiceFailed>
  }
>()("balabol/voice-transport") {}
export const SessionId = Id
export const MuteRequest = Schema.Struct({ muted: Schema.Boolean })
