import { randomUUID, randomBytes } from "node:crypto"
import type { Scope } from "effect"
import { Effect, Schema, Redacted } from "effect"
import type { Message, Conversation, InputSource } from "../conversation/index.ts"
import {
  RecognitionFailed,
  type RecognitionFailureReason,
  type SpeechRecognition
} from "../speech-recognition/index.ts"
import { VoiceFrame, VoiceEvent, VoiceFailed, failed, sameDetectedLanguage } from "./contracts.ts"
import type { VoiceSnapshot, MediaConnection, PendingVoiceInput } from "./contracts.ts"
import type { LanguageSpan } from "../language/index.ts"
import type { ReplyAudio } from "./output.ts"
import type { VoiceAdmissions } from "./admissions.ts"
import type { ActivityStream, ActivityWindow } from "./activity.ts"
import { Segmenter } from "./segmentation.ts"
import { Utterances } from "./utterances.ts"
import { disabledVoiceDiagnostics, recordVoiceDiagnostic, diagnosticErrorCode } from "./diagnostics.ts"
import type { VoiceDiagnostics, VoiceDiagnosticInput } from "./diagnostics.ts"
const datagramPublishMillis = 250
const capabilityBytes = 32
const maximumEvents = 100
const maximumEventBytes = 256000
const maximumPending = 2
type EventInput = VoiceEvent extends infer E
  ? E extends VoiceEvent
    ? Omit<E, "sequence" | "sessionId">
    : never
  : never
export class Session {
  readonly id = randomUUID()
  readonly controlToken = Redacted.make(randomBytes(capabilityBytes).toString("hex"))
  readonly roomName = randomUUID()
  readonly participantIdentity = randomUUID()
  readonly segmenter = new Segmenter()
  readonly events: VoiceEvent[] = []
  sequence = 0
  status: "active" | "ended" = "active"
  muted: boolean
  joined = false
  joinDeadlineAt = 0
  controlDeadlineAt = 0
  track: string | undefined
  generation = 0
  admissions = 0
  speechRevision = 0
  inputSource: InputSource | undefined
  readonly admitting = new Set<string>()
  audioFramesReceived = 0
  sampleFramesReceived = 0
  readonly finals = new Map<string, PendingVoiceInput>()
  readonly unresolved = new Map<
    string,
    { text: string; languageSpans: readonly LanguageSpan[]; detectedLanguage: string | null }
  >()
  audio: ReplyAudio | undefined
  connection: MediaConnection | undefined
  release = Effect.void
  readonly utterances: Utterances
  constructor(
    readonly conversation: Conversation["Service"],
    readonly provider: SpeechRecognition["Service"],
    readonly scope: Scope.Scope,
    readonly admissionStore: VoiceAdmissions["Service"],
    readonly startRequestId: string,
    readonly initialMuted: boolean,
    readonly allowedLanguages: readonly string[],
    readonly activity: ActivityStream,
    readonly diagnostics: VoiceDiagnostics["Service"] = disabledVoiceDiagnostics,
    source?: InputSource
  ) {
    this.muted = initialMuted
    this.inputSource = source
    this.utterances = new Utterances(provider, allowedLanguages, scope, {
      final: (id, text, spans, language) =>
        this.admit(id, text, spans, language).pipe(
          Effect.catch((error) =>
            this.emit({ kind: "Error", utteranceId: id, code: error.code, message: error.message })
          )
        ),
      interim: (utteranceId, text) => this.emit({ kind: "Interim", utteranceId, text }),
      discarded: (utteranceId) => this.emit({ kind: "Discarded", utteranceId, reason: "Empty" }),
      error: (utteranceId, error) =>
        this.emit(
          {
            kind: "Error",
            utteranceId,
            code: error instanceof VoiceFailed ? error.code : error._tag,
            message: error.message
          },
          error instanceof RecognitionFailed ? (error.reason ?? "Other") : undefined
        ),
      started: (samples) => this.trace("recognitionStarted", undefined, undefined, samples),
      succeeded: () => this.trace("recognitionSucceeded")
    })
  }
  get backendIncarnationId() {
    return this.admissionStore.backendIncarnationId
  }
  trace(
    cause: VoiceDiagnosticInput["cause"],
    code?: string,
    reason?: typeof RecognitionFailureReason.Type,
    sampleFrames?: number
  ) {
    recordVoiceDiagnostic(this.diagnostics, {
      cause,
      sessionId: this.id,
      applied: true,
      generation: this.generation,
      ...(code === undefined ? {} : { errorCode: diagnosticErrorCode(code) }),
      ...(reason === undefined ? {} : { recognitionReason: reason }),
      ...(sampleFrames === undefined ? {} : { sampleFrames })
    })
  }
  #traceEvent(input: EventInput, recognitionReason?: typeof RecognitionFailureReason.Type) {
    if (input.kind === "Error") this.trace("sessionError", input.code, recognitionReason)
    if (input.kind === "Discarded") this.trace("recognitionDiscarded")
  }
  emit(input: EventInput, recognitionReason?: typeof RecognitionFailureReason.Type) {
    return Effect.gen({ self: this }, function* () {
      this.#traceEvent(input, recognitionReason)
      const event = yield* Schema.decodeUnknownEffect(VoiceEvent)({
        ...input,
        sessionId: this.id,
        sequence: ++this.sequence
      }).pipe(Effect.orDie)
      this.events.push(event)
      while (
        this.events.length > maximumEvents ||
        new TextEncoder().encode(JSON.stringify(this.events)).length > maximumEventBytes
      )
        this.events.shift()
      if (this.status === "active")
        yield* this.connection?.publish(event).pipe(Effect.timeout(datagramPublishMillis), Effect.ignore) ?? Effect.void
    })
  }
  admit(utteranceId: string, text: string, languageSpans: readonly LanguageSpan[], detectedLanguage: string | null) {
    const sourceSequence = this.speechRevision
    return Effect.gen({ self: this }, function* () {
      const association = {
        backendIncarnationId: this.backendIncarnationId,
        sessionId: this.id,
        deliveryId: utteranceId
      }
      if (new Set([...this.admitting, ...this.unresolved.keys()]).size >= maximumPending)
        return yield* failed("RecognitionFailed", "Speech admission capacity exceeded; repeat this utterance")
      this.admissions += 1
      this.admitting.add(utteranceId)
      this.inputSource ??= yield* this.conversation
        .openInputSource()
        .pipe(Effect.mapError((error) => failed("InvalidInput", error.message)))
      const reservation = yield* this.conversation
        .registerInput({
          message: { deliveryId: utteranceId, text, languageSpans, detectedLanguage },
          source: { capability: this.inputSource, sequence: sourceSequence }
        })
        .pipe(
          Effect.mapError((error) => failed("StorageUnavailable", error.message)),
          Effect.tapError(() =>
            Effect.sync(() => {
              this.admissions -= 1
              this.admitting.delete(utteranceId)
              this.audio?.releaseAdmission(utteranceId)
            })
          )
        )
      yield* this.admissionStore.begin({ ...association, text, languageSpans, detectedLanguage }).pipe(
        Effect.tapError(() =>
          this.conversation.abandonInput(reservation).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                this.admissions -= 1
                this.admitting.delete(utteranceId)
                this.audio?.releaseAdmission(utteranceId)
              })
            )
          )
        )
      )
      const deliveryId = utteranceId
      this.unresolved.set(utteranceId, { text, languageSpans, detectedLanguage })
      this.finals.set(utteranceId, {
        backendIncarnationId: this.backendIncarnationId,
        utteranceId,
        deliveryId,
        text,
        languageSpans,
        detectedLanguage,
        receipt: null,
        error: null
      })
      if (this.finals.size > maximumPending) {
        const accepted = [...this.finals.values()].find((input) => input.receipt !== null)
        if (accepted !== undefined) this.finals.delete(accepted.utteranceId)
      }
      const send = this.conversation.submitInput(reservation).pipe(
        Effect.flatMap((receipt) => this.accept(utteranceId, receipt)),
        Effect.catch((error) => {
          if (this.finals.get(utteranceId)?.receipt != null) return Effect.void
          this.finals.set(utteranceId, {
            backendIncarnationId: this.backendIncarnationId,
            utteranceId,
            deliveryId,
            text,
            languageSpans,
            detectedLanguage,
            receipt: null,
            error: { code: error._tag, message: error.message }
          })
          return this.emit({ kind: "Error", utteranceId, code: error._tag, message: error.message })
        }),
        Effect.ensuring(
          this.admissionStore.seal(association).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                this.admissions -= 1
                this.admitting.delete(utteranceId)
                this.audio?.releaseAdmission(utteranceId)
              })
            )
          )
        ),
        Effect.forkIn(this.scope),
        Effect.asVoid
      )
      yield* this.emit({
        kind: "Final",
        backendIncarnationId: this.backendIncarnationId,
        utteranceId,
        deliveryId,
        text,
        languageSpans,
        detectedLanguage
      }).pipe(Effect.andThen(send))
    }).pipe(Effect.uninterruptible)
  }
  accept(utteranceId: string, receipt: Message) {
    const input = this.unresolved.get(utteranceId)
    if (
      receipt.role !== "user" ||
      receipt.deliveryId !== utteranceId ||
      receipt.text !== input?.text ||
      JSON.stringify(receipt.languageSpans) !== JSON.stringify(input.languageSpans) ||
      !sameDetectedLanguage(receipt.detectedLanguage, input.detectedLanguage)
    )
      return Effect.void
    this.unresolved.delete(utteranceId)
    this.finals.set(utteranceId, {
      backendIncarnationId: this.backendIncarnationId,
      utteranceId,
      deliveryId: utteranceId,
      text: receipt.text,
      languageSpans: receipt.languageSpans,
      detectedLanguage: receipt.detectedLanguage ?? null,
      receipt,
      error: null
    })
    return this.emit({ kind: "Accepted", utteranceId, receipt })
  }
  selectTrack(track: string) {
    if (this.track === track) return
    if (this.track !== undefined) {
      this.generation += 1
      this.utterances.reset()
    }
    this.segmenter.clear()
    this.activity.reset()
    this.track = track
  }
  interruptOnSpeech() {
    return (this.audio?.speechStarted(this.generation) ?? Effect.void).pipe(
      Effect.catch((error) =>
        this.emit({ kind: "Error", utteranceId: null, code: error.code, message: error.message })
      ),
      Effect.forkIn(this.scope),
      Effect.asVoid
    )
  }
  frame(track: string, raw: unknown) {
    return Effect.gen({ self: this }, function* () {
      if (this.status !== "active" || this.muted) return
      const frame = yield* Schema.decodeUnknownEffect(VoiceFrame)(raw).pipe(
        Effect.mapError(() => failed("InvalidAudio", "Expected 16 kHz mono 20 ms PCM audio"))
      )
      this.audioFramesReceived += 1
      this.sampleFramesReceived += frame.samplesPerChannel
      this.selectTrack(track)
      const generation = this.generation
      const windows = yield* this.activity.push(frame)
      yield* this.classified(windows, generation)
    }).pipe(
      Effect.catch((error) => {
        this.audio?.trace("captureError", true)
        this.fenceInput()
        return this.emit({ kind: "Error", utteranceId: null, code: error.code, message: error.message })
      })
    )
  }
  classified(windows: readonly ActivityWindow[], generation: number) {
    return Effect.gen({ self: this }, function* () {
      if (generation !== this.generation || this.muted || this.status !== "active") return
      for (const window of windows)
        for (const event of this.segmenter.push(window)) {
          if (event.speechStarted) yield* this.startUtterance()
          if (event.bytes !== undefined) yield* this.utterances.push(event.bytes, event.ended === true)
        }
    })
  }
  startUtterance() {
    if (!this.utterances.start()) return Effect.void
    this.speechRevision += 1
    const sequence = this.speechRevision
    for (const id of this.admitting) this.audio?.suppressDelivery(id)
    const interrupted = this.interruptOnSpeech()
    return Effect.gen({ self: this }, function* () {
      this.inputSource ??= yield* this.conversation
        .openInputSource()
        .pipe(Effect.mapError((error) => failed("InvalidInput", error.message)))
      yield* this.conversation
        .fenceSpeech({ capability: this.inputSource, sequence, fenceId: randomUUID() })
        .pipe(Effect.mapError((error) => failed("InvalidInput", error.message)))
    }).pipe(Effect.ensuring(interrupted))
  }
  fenceInput() {
    this.generation += 1
    this.segmenter.clear()
    this.activity.reset()
    this.utterances.reset()
  }
  stop() {
    return Effect.gen({ self: this }, function* () {
      this.fenceInput()
      if (this.status === "ended" && this.inputSource !== undefined)
        yield* this.conversation.closeInputSource(this.inputSource).pipe(Effect.ignore)
      yield* this.utterances.close()
    })
  }
  reconcile() {
    return Effect.forEach(
      this.unresolved.keys(),
      (utteranceId) =>
        this.conversation.receipt(utteranceId).pipe(
          Effect.flatMap((receipt) => {
            return receipt === null ? Effect.void : this.accept(utteranceId, receipt)
          }),
          Effect.ignore
        ),
      { discard: true }
    )
  }
  snapshot(after: number): VoiceSnapshot {
    const events = this.events.filter((event) => event.sequence > after)
    return {
      backendIncarnationId: this.backendIncarnationId,
      controlDeadlineAt: this.controlDeadlineAt,
      sessionId: this.id,
      status: this.status,
      muted: this.muted,
      sequence: this.sequence,
      events,
      firstSequence: this.events[0]?.sequence ?? this.sequence + 1,
      audioFramesReceived: this.audioFramesReceived,
      sampleFramesReceived: this.sampleFramesReceived,
      pending: [...this.finals.values()],
      output: this.audio?.snapshot ?? null,
      nextAfter: this.sequence
    }
  }
}
