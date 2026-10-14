import { randomUUID, randomBytes } from "node:crypto"
import type { Scope } from "effect"
import { Effect, Fiber, Schema, Stream, Redacted } from "effect"
import type { Message, Conversation } from "../conversation/index.ts"
import type { SpeechRecognition } from "../speech-recognition/index.ts"
import { RecognitionEvent } from "../speech-recognition/index.ts"
import { VoiceFrame, VoiceEvent, failed } from "./contracts.ts"
import type { VoiceSnapshot, MediaConnection, PendingVoiceInput } from "./contracts.ts"
import type { ReplyAudio } from "./output.ts"
import type { VoiceAdmissions } from "./admissions.ts"
import { Segmenter } from "./segmentation.ts"
const datagramPublishMillis = 250
const capabilityBytes = 32
const maximumEvents = 100
const maximumEventBytes = 256000
const bytesPerSample = 2
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
  pending = 0
  admissions = 0
  audioFramesReceived = 0
  sampleFramesReceived = 0
  readonly finals = new Map<string, PendingVoiceInput>()
  readonly unresolved = new Map<string, string>()
  audio: ReplyAudio | undefined
  connection: MediaConnection | undefined
  release = Effect.void
  recognition = new Set<Fiber.Fiber<void>>()
  constructor(
    readonly conversation: Conversation["Service"],
    readonly provider: SpeechRecognition["Service"],
    readonly scope: Scope.Scope,
    readonly admissionStore: VoiceAdmissions["Service"],
    readonly startRequestId: string,
    readonly initialMuted: boolean
  ) {
    this.muted = initialMuted
  }
  get backendIncarnationId() {
    return this.admissionStore.backendIncarnationId
  }
  emit(input: EventInput) {
    return Effect.gen({ self: this }, function* () {
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
  admit(utteranceId: string, text: string) {
    return Effect.gen({ self: this }, function* () {
      const association = {
        backendIncarnationId: this.backendIncarnationId,
        sessionId: this.id,
        deliveryId: utteranceId
      }
      yield* this.admissionStore.begin({ ...association, text })
      const deliveryId = utteranceId
      this.admissions += 1
      this.unresolved.set(utteranceId, text)
      this.finals.set(utteranceId, {
        backendIncarnationId: this.backendIncarnationId,
        utteranceId,
        deliveryId,
        text,
        receipt: null,
        error: null
      })
      if (this.finals.size > maximumPending) {
        const accepted = [...this.finals.values()].find((input) => input.receipt !== null)
        if (accepted !== undefined) this.finals.delete(accepted.utteranceId)
      }
      const send = this.conversation.send({ deliveryId, text }).pipe(
        Effect.flatMap((receipt) => this.accept(utteranceId, receipt)),
        Effect.catch((error) => {
          if (this.finals.get(utteranceId)?.receipt != null) return Effect.void
          this.finals.set(utteranceId, {
            backendIncarnationId: this.backendIncarnationId,
            utteranceId,
            deliveryId,
            text,
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
        text
      }).pipe(Effect.andThen(send))
    }).pipe(Effect.uninterruptible)
  }
  accept(utteranceId: string, receipt: Message) {
    if (
      receipt.role !== "user" ||
      receipt.deliveryId !== utteranceId ||
      receipt.text !== this.unresolved.get(utteranceId)
    )
      return Effect.void
    this.unresolved.delete(utteranceId)
    this.finals.set(utteranceId, {
      backendIncarnationId: this.backendIncarnationId,
      utteranceId,
      deliveryId: utteranceId,
      text: receipt.text,
      receipt,
      error: null
    })
    return this.emit({ kind: "Accepted", utteranceId, receipt })
  }
  recognize(bytes: Uint8Array) {
    const utteranceId = randomUUID()
    const generation = this.generation
    let final = false
    return this.provider
      .recognize({
        utteranceId,
        allowedLanguages: ["ru", "fr", "en"],
        audio: {
          encoding: "pcm-s16le",
          sampleRateHz: 16000,
          channels: 1,
          sampleFrames: bytes.length / bytesPerSample,
          bytes
        }
      })
      .pipe(
        Stream.runForEach((raw) =>
          Schema.decodeUnknownEffect(RecognitionEvent)(raw).pipe(
            Effect.mapError(() => failed("InvalidRecognition", "Invalid recognition event")),
            Effect.flatMap((event) => {
              if (this.generation !== generation || event.utteranceId !== utteranceId || final) return Effect.void
              if (event.kind === "Interim") return this.emit({ kind: "Interim", utteranceId, text: event.text })
              final = true
              return event.text.trim().length === 0
                ? this.emit({ kind: "Discarded", utteranceId, reason: "Empty" })
                : this.admit(utteranceId, event.text)
            })
          )
        ),
        Effect.catch((error) => this.emit({ kind: "Error", utteranceId, code: error._tag, message: error.message })),
        Effect.ensuring(
          Effect.sync(() => {
            this.pending -= 1
          })
        ),
        Effect.asVoid
      )
  }
  selectTrack(track: string) {
    if (this.track === track) return
    if (this.track !== undefined) this.generation += 1
    this.segmenter.clear()
    this.track = track
  }
  interruptOnSpeech(frame: VoiceFrame) {
    if (!this.segmenter.speechStarted(frame)) return Effect.void
    return (this.audio?.speechStarted() ?? Effect.void).pipe(
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
      yield* this.interruptOnSpeech(frame)
      const bytes = this.segmenter.push(frame)
      if (bytes === undefined) return
      if (this.pending + this.admissions >= maximumPending || this.unresolved.size >= maximumPending)
        return yield* failed("Overloaded", "Recognition capacity exceeded; repeat this utterance")
      this.pending += 1
      const fiber = yield* this.recognize(bytes).pipe(Effect.forkIn(this.scope))
      this.recognition.add(fiber)
      yield* Fiber.await(fiber).pipe(
        Effect.andThen(Effect.sync(() => this.recognition.delete(fiber))),
        Effect.forkIn(this.scope)
      )
    }).pipe(
      Effect.catch((error) => this.emit({ kind: "Error", utteranceId: null, code: error.code, message: error.message }))
    )
  }
  stop() {
    return Effect.gen({ self: this }, function* () {
      this.generation += 1
      this.segmenter.clear()
      for (const fiber of this.recognition) yield* Fiber.interrupt(fiber)
      this.recognition.clear()
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
