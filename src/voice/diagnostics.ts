import { createHash, randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Clock, Context, Effect, Layer, Schema, Option } from "effect"
import { FailureReason } from "../delivery-failure/index.ts"
import { RecognitionFailureReason } from "../speech-recognition/index.ts"
const maximumRecognitionSamples = 240000
const maximumEvents = 256
const maximumBytes = 131072
const correlationLength = 12
const nanosPerMilli = 1000000
export const VoiceDiagnosticCause = Schema.Literals([
  "backendSpeech",
  "clientInterrupt",
  "conversationInvalidation",
  "deadline",
  "failed",
  "detach",
  "lifecycle",
  "queueOverflow",
  "captureError",
  "recognitionStarted",
  "recognitionSucceeded",
  "recognitionDefect",
  "outputDefect",
  "recognitionDiscarded",
  "sessionError"
])
export const VoiceDiagnosticErrorCode = Schema.Literals([
  "RecognitionFailed",
  "InvalidRecognition",
  "InvalidAudio",
  "ActivityUnavailable",
  "Overloaded",
  "StorageUnavailable",
  "AdmissionConflict",
  "InvalidInput",
  "AudioUnavailable",
  "MediaDisconnected",
  "SessionExpired",
  "Other"
])
export const diagnosticErrorCode = (code: string): typeof VoiceDiagnosticErrorCode.Type =>
  Option.getOrElse(Schema.decodeUnknownOption(VoiceDiagnosticErrorCode)(code), () => "Other")
export const VoiceDiagnosticInput = Schema.Struct({
  cause: VoiceDiagnosticCause,
  failureReason: Schema.optionalKey(FailureReason),
  errorCode: Schema.optionalKey(VoiceDiagnosticErrorCode),
  recognitionReason: Schema.optionalKey(RecognitionFailureReason),
  sampleFrames: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumRecognitionSamples }))
  ),
  sessionId: Schema.String.check(Schema.isUUID()),
  responseId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  inputDeliveryId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  outputEpoch: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  priorStatus: Schema.optionalKey(
    Schema.Literals(["Preparing", "AwaitingReady", "Playing", "Delivered", "Interrupted", "Failed"])
  ),
  applied: Schema.Boolean,
  generation: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})
export type VoiceDiagnosticInput = typeof VoiceDiagnosticInput.Type
const correlation = (value: string) =>
  createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, correlationLength)
export const VoiceDiagnosticRecord = Schema.Struct({
  cause: VoiceDiagnosticCause,
  failureReason: Schema.optionalKey(FailureReason),
  session: Schema.String,
  errorCode: VoiceDiagnosticInput.fields.errorCode,
  recognitionReason: VoiceDiagnosticInput.fields.recognitionReason,
  sampleFrames: VoiceDiagnosticInput.fields.sampleFrames,
  response: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  epoch: Schema.optionalKey(Schema.String),
  priorStatus: VoiceDiagnosticInput.fields.priorStatus,
  applied: Schema.Boolean,
  generation: VoiceDiagnosticInput.fields.generation,
  sequence: Schema.Int,
  elapsedMillis: Schema.Number
})
export type VoiceDiagnosticRecord = typeof VoiceDiagnosticRecord.Type
const recognitionMetadata = (parsed: VoiceDiagnosticInput) => ({
  ...(parsed.recognitionReason === undefined ? {} : { recognitionReason: parsed.recognitionReason }),
  ...(parsed.sampleFrames === undefined ? {} : { sampleFrames: parsed.sampleFrames })
})
const projectRecord = (parsed: VoiceDiagnosticInput) => ({
  cause: parsed.cause,
  ...(parsed.failureReason === undefined ? {} : { failureReason: parsed.failureReason }),
  session: correlation(parsed.sessionId),
  applied: parsed.applied,
  ...(parsed.errorCode === undefined ? {} : { errorCode: parsed.errorCode }),
  ...recognitionMetadata(parsed),
  ...(parsed.responseId === undefined ? {} : { response: correlation(parsed.responseId) }),
  ...(parsed.inputDeliveryId === undefined ? {} : { input: correlation(parsed.inputDeliveryId) }),
  ...(parsed.outputEpoch === undefined ? {} : { epoch: correlation(parsed.outputEpoch) }),
  ...(parsed.priorStatus === undefined ? {} : { priorStatus: parsed.priorStatus }),
  ...(parsed.generation === undefined ? {} : { generation: parsed.generation })
})
export class VoiceDiagnostics extends Context.Service<
  VoiceDiagnostics,
  { record: (input: VoiceDiagnosticInput) => void }
>()("balabol/voice/diagnostics") {}
export const disabledVoiceDiagnostics: VoiceDiagnostics["Service"] = { record: () => {} }
/** A diagnostic adapter can never throw into the conversation's control path. */
export const recordVoiceDiagnostic = (sink: VoiceDiagnostics["Service"], input: VoiceDiagnosticInput) => {
  try {
    sink.record(input)
  } catch {
    /* Diagnostics cannot affect voice state. */
  }
}
export interface VoiceDiagnosticStorage {
  write: (snapshot: string, signal: AbortSignal) => Promise<void>
}
export const voiceDiagnosticFile = (path: string): VoiceDiagnosticStorage => ({
  async write(snapshot, signal) {
    const temporary = `${path}.pending`
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      await writeFile(temporary, snapshot, { mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
})
export const voiceDiagnosticsLayer = (storage: VoiceDiagnosticStorage) =>
  Layer.effect(
    VoiceDiagnostics,
    Effect.gen(function* () {
      const run = randomUUID()
      const clock = yield* Clock.Clock
      const wallAnchor = yield* Clock.currentTimeMillis
      const started = clock.monotonicTimeNanosUnsafe()
      const controller = new AbortController()
      const events: VoiceDiagnosticRecord[] = []
      let sequence = 0
      let dropped = 0
      let writeFailures = 0
      let pending: string | undefined
      let writing = false
      let closed = false
      const drain = async () => {
        writing = true
        while (!closed && pending !== undefined) {
          const snapshot = pending
          pending = undefined
          try {
            await storage.write(snapshot, controller.signal)
          } catch {
            writeFailures += 1
          }
        }
        writing = false
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true
          pending = undefined
          controller.abort()
        })
      )
      return VoiceDiagnostics.of({
        record(input) {
          if (closed) return
          const parsed = Schema.decodeUnknownSync(VoiceDiagnosticInput)(input)
          events.push({
            ...projectRecord(parsed),
            sequence: ++sequence,
            elapsedMillis: Number(clock.monotonicTimeNanosUnsafe() - started) / nanosPerMilli
          })
          if (events.length > maximumEvents) {
            events.shift()
            dropped += 1
          }
          const snapshot = JSON.stringify({ run, wallAnchor, dropped, writeFailures, events })
          if (Buffer.byteLength(snapshot) > maximumBytes) {
            dropped += 1
            return
          }
          pending = snapshot
          if (!writing) void drain()
        }
      })
    })
  )
