import type { FailureDiagnostic } from "../failure-diagnostic/index.ts"
import { Schema } from "effect"
import { SpeechSynthesisFailed } from "./provider.ts"
const maximumBytes = 2880000
const maximumBase64 = 3840000
const maximumPacket = 3841024
const unauthorized = 401
const forbidden = 403
const paymentRequired = 402
const quotaExceeded = 429
const minimumHttpStatus = 100
const maximumHttpStatus = 599
const base64Group = 4
const pcmFrameBytes = 2
const Packet = Schema.Struct({
  stream_id: Schema.optionalKey(Schema.String),
  audio: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumBase64))),
  audio_end: Schema.optionalKey(Schema.Boolean),
  terminated: Schema.optionalKey(Schema.Boolean),
  error_code: Schema.optionalKey(Schema.Number),
  error_type: Schema.optionalKey(Schema.String),
  error_message: Schema.optionalKey(Schema.String)
})
export const sonioxSynthesisFailure = (
  message: string,
  failure: FailureDiagnostic["reason"] = "Protocol",
  status?: number
) =>
  new SpeechSynthesisFailed({
    message,
    diagnostic: {
      category: "Synthesis",
      reason: failure,
      provider: "soniox",
      ...(status !== undefined && Number.isInteger(status) && status >= minimumHttpStatus && status <= maximumHttpStatus
        ? { status }
        : {})
    }
  })
const statusReason = (status: number): FailureDiagnostic["reason"] => {
  if (status === unauthorized || status === forbidden) return "Authentication"
  if (status === paymentRequired) return "Billing"
  return status === quotaExceeded ? "Quota" : "Provider"
}
export interface SonioxAudioState {
  readonly bytes: number
  readonly audioEnded: boolean
  readonly terminated: boolean
}
export const emptySonioxAudio: SonioxAudioState = { bytes: 0, audioEnded: false, terminated: false }
const providerFailure = (code: number) => {
  if (code === unauthorized || code === forbidden)
    return "Soniox rejected the API key; check SONIOX_API_KEY and account permissions"
  if (code === paymentRequired) return "Soniox requires available account credit; check billing"
  if (code === quotaExceeded) return "Soniox synthesis quota exceeded; retry later or check account limits"
  return "Soniox synthesis failed; check provider availability and account configuration"
}
const decodeAudio = (audio: string) => {
  if (
    audio.length % base64Group !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(audio)
  )
    throw sonioxSynthesisFailure("Invalid Soniox base64 audio")
  const bytes = Buffer.from(audio, "base64")
  if (bytes.toString("base64") !== audio) throw sonioxSynthesisFailure("Invalid Soniox PCM audio")
  return bytes
}
const parsePacket = (raw: unknown, identity: string) => {
  if (typeof raw !== "string" || raw.length > maximumPacket)
    throw sonioxSynthesisFailure("Invalid Soniox synthesis packet")
  const packet = Schema.decodeUnknownSync(Packet)(JSON.parse(raw))
  if (packet.error_code !== undefined || packet.error_type !== undefined)
    throw sonioxSynthesisFailure(
      providerFailure(packet.error_code ?? 0),
      statusReason(packet.error_code ?? 0),
      packet.error_code
    )
  if (packet.stream_id !== identity) throw sonioxSynthesisFailure("Unexpected Soniox synthesis identity")
  return packet
}
const checkAudioOrder = (state: SonioxAudioState, audio: Uint8Array, ended: boolean) => {
  if (
    state.terminated ||
    (state.audioEnded && (audio.length > 0 || ended)) ||
    state.bytes + audio.length > maximumBytes
  )
    throw sonioxSynthesisFailure("Soniox audio order or duration limit exceeded")
}
const checkTerminal = (state: SonioxAudioState, audio: Uint8Array, terminated: boolean) => {
  if (terminated && (!state.audioEnded || audio.length > 0 || state.bytes === 0))
    throw sonioxSynthesisFailure("Soniox terminated before complete audio")
}
/** Provider completion is valid only after bounded nonempty PCM and explicit audio_end. */
export const reduceSonioxAudio = (state: SonioxAudioState, raw: unknown, identity: string) => {
  const packet = parsePacket(raw, identity)
  const audio = decodeAudio(packet.audio ?? "")
  const audioEnded = packet.audio_end === true
  if (audioEnded && (state.bytes + audio.length) % pcmFrameBytes !== 0)
    throw sonioxSynthesisFailure("Invalid Soniox PCM audio")
  const terminated = packet.terminated === true
  checkAudioOrder(state, audio, audioEnded)
  checkTerminal(state, audio, terminated)
  return { state: { bytes: state.bytes + audio.length, audioEnded: state.audioEnded || audioEnded, terminated }, audio }
}
