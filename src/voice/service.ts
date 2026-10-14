import { randomUUID, randomBytes } from "node:crypto"
import { Context, Effect, Fiber, Layer, Schema, Stream, Queue, Redacted, Scope, Exit, Semaphore } from "effect"
import type { Message } from "../conversation/index.ts"
import { Conversation } from "../conversation/index.ts"
import { SpeechRecognition, RecognitionEvent } from "../speech-recognition/index.ts"
import { VoiceTransport, VoiceFrame, VoiceEvent, SessionId, failed } from "./contracts.ts"
import type { VoiceJoin, VoiceSnapshot, VoiceFailed, MediaConnection, PendingVoiceInput } from "./contracts.ts"
import { Segmenter } from "./segmentation.ts"
const datagramPublishMillis = 250
const capabilityBytes = 32
const maximumEvents = 100
const maximumEventBytes = 256000
const bytesPerSample = 2
const maximumPending = 2
const maximumSessions = 2
const disconnectPollMillis = 20
type EventInput = VoiceEvent extends infer E
  ? E extends VoiceEvent
    ? Omit<E, "sequence" | "sessionId">
    : never
  : never
class Session {
  readonly id = randomUUID()
  readonly controlToken = Redacted.make(randomBytes(capabilityBytes).toString("hex"))
  readonly roomName = randomUUID()
  readonly participantIdentity = randomUUID()
  readonly segmenter = new Segmenter()
  readonly events: VoiceEvent[] = []
  sequence = 0
  status: "active" | "ended" = "active"
  muted = false
  track: string | undefined
  generation = 0
  pending = 0
  admissions = 0
  audioFramesReceived = 0
  sampleFramesReceived = 0
  readonly finals = new Map<string, PendingVoiceInput>()
  readonly unresolved = new Map<string, string>()
  connection: MediaConnection | undefined
  release = Effect.void
  recognition = new Set<Fiber.Fiber<void>>()
  constructor(
    readonly conversation: Conversation["Service"],
    readonly provider: SpeechRecognition["Service"],
    readonly scope: Scope.Scope
  ) {}
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
    const deliveryId = utteranceId
    this.admissions += 1
    this.unresolved.set(utteranceId, text)
    this.finals.set(utteranceId, { utteranceId, deliveryId, text, receipt: null, error: null })
    if (this.finals.size > maximumPending) {
      const accepted = [...this.finals.values()].find((input) => input.receipt !== null)
      if (accepted !== undefined) this.finals.delete(accepted.utteranceId)
    }
    const send = this.conversation.send({ deliveryId, text }).pipe(
      Effect.flatMap((receipt) => this.accept(utteranceId, receipt)),
      Effect.catch((error) => {
        this.finals.set(utteranceId, {
          utteranceId,
          deliveryId,
          text,
          receipt: null,
          error: { code: error._tag, message: error.message }
        })
        return this.emit({ kind: "Error", utteranceId, code: error._tag, message: error.message })
      }),
      Effect.ensuring(
        Effect.sync(() => {
          this.admissions -= 1
        })
      ),
      Effect.forkIn(this.scope),
      Effect.asVoid
    )
    return this.emit({ kind: "Final", utteranceId, deliveryId, text }).pipe(
      Effect.andThen(send),
      Effect.uninterruptible
    )
  }
  accept(utteranceId: string, receipt: Message) {
    if (!this.unresolved.delete(utteranceId)) return Effect.void
    this.finals.set(utteranceId, { utteranceId, deliveryId: utteranceId, text: receipt.text, receipt, error: null })
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
  frame(track: string, raw: unknown) {
    return Effect.gen({ self: this }, function* () {
      if (this.status !== "active" || this.muted) return
      const frame = yield* Schema.decodeUnknownEffect(VoiceFrame)(raw).pipe(
        Effect.mapError(() => failed("InvalidAudio", "Expected 16 kHz mono 20 ms PCM audio"))
      )
      this.audioFramesReceived += 1
      this.sampleFramesReceived += frame.samplesPerChannel
      this.selectTrack(track)
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
      sessionId: this.id,
      status: this.status,
      muted: this.muted,
      sequence: this.sequence,
      events,
      firstSequence: this.events[0]?.sequence ?? this.sequence + 1,
      audioFramesReceived: this.audioFramesReceived,
      sampleFramesReceived: this.sampleFramesReceived,
      pending: [...this.finals.values()],
      nextAfter: this.sequence
    }
  }
}
export class Voice extends Context.Service<
  Voice,
  {
    authorize: (id: string, token: string) => Effect.Effect<void, VoiceFailed>
    start: () => Effect.Effect<VoiceJoin, VoiceFailed>
    snapshot: (id: string, after: number) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    mute: (id: string, muted: boolean) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    end: (id: string) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  }
>()("balabol/voice") {
  static readonly layer = Layer.effect(
    Voice,
    Effect.gen(function* () {
      const conversation = yield* Conversation
      const provider = yield* SpeechRecognition
      const transport = yield* VoiceTransport
      const scope = yield* Effect.scope
      const sessions = new Map<string, Session>()
      const starts = yield* Semaphore.make(1)
      const get = (id: string) =>
        Schema.decodeUnknownEffect(SessionId)(id).pipe(
          Effect.mapError(() => failed("InvalidSession", "Invalid session identity")),
          Effect.flatMap((parsed) => {
            const session = sessions.get(parsed.toLowerCase())
            return session === undefined
              ? Effect.fail(failed("SessionNotFound", "Voice session unavailable"))
              : Effect.succeed(session)
          })
        )
      const end = (session: Session) =>
        Effect.gen(function* () {
          if (session.status === "ended") return session.snapshot(0)
          session.status = "ended"
          yield* session.stop()
          yield* session.connection?.close() ?? Effect.void
          yield* session.release
          yield* session.emit({ kind: "Ended" })
          return session.snapshot(0)
        })
      yield* Effect.addFinalizer(() => Effect.forEach(sessions.values(), end, { discard: true }))
      return Voice.of({
        authorize: (id, token) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              token === Redacted.value(session.controlToken)
                ? Effect.void
                : Effect.fail(failed("Unauthorized", "Invalid session capability"))
            )
          ),
        start: () =>
          Effect.gen(function* () {
            if ([...sessions.values()].some((session) => session.status === "active"))
              return yield* failed("VoiceBusy", "A voice session is already active")
            if (sessions.size >= maximumSessions) {
              const ended = [...sessions.values()].find(
                (session) => session.status === "ended" && session.admissions === 0
              )
              if (ended === undefined) return yield* failed("VoiceBusy", "Previous acceptance is still pending")
              sessions.delete(ended.id)
            }
            const session = new Session(conversation, provider, scope)
            const sessionScope = yield* Scope.fork(scope)
            session.release = Scope.close(sessionScope, Exit.void)
            const frames = yield* Queue.make<{ track: string; raw: unknown; generation: number }>({ capacity: 8 })
            let disconnected: string | undefined
            yield* Effect.forever(
              Queue.take(frames).pipe(
                Effect.flatMap((value) =>
                  value.generation === session.generation ? session.frame(value.track, value.raw) : Effect.void
                )
              )
            ).pipe(Effect.forkIn(sessionScope))
            const opened = yield* transport
              .open(
                { sessionId: session.id, roomName: session.roomName, participantIdentity: session.participantIdentity },
                (track, raw) => {
                  if (!Queue.offerUnsafe(frames, { track, raw, generation: session.generation }))
                    disconnected = "Overloaded"
                },
                () => {
                  disconnected = "MediaDisconnected"
                }
              )
              .pipe(Effect.onError(() => session.release))
            yield* Effect.gen(function* () {
              while (session.status === "active") {
                yield* Effect.sleep(disconnectPollMillis)
                if (disconnected !== undefined) {
                  yield* session.emit({
                    kind: "Error",
                    utteranceId: null,
                    code: disconnected,
                    message: "Media disconnected or audio queue overloaded"
                  })
                  yield* end(session)
                }
              }
            }).pipe(Effect.forkIn(scope))
            session.connection = opened.connection
            sessions.set(session.id, session)
            return { ...opened.join, controlToken: Redacted.value(session.controlToken) }
          }).pipe(starts.withPermits(1)),
        snapshot: (id, after) =>
          get(id).pipe(
            Effect.flatMap((session) => session.reconcile().pipe(Effect.map(() => session.snapshot(after))))
          ),
        mute: (id, muted) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              Effect.gen(function* () {
                session.muted = muted
                yield* session.stop()
                yield* session.emit({ kind: "Muted", muted })
                return session.snapshot(0)
              })
            )
          ),
        end: (id) => get(id).pipe(Effect.flatMap(end))
      })
    })
  )
}
