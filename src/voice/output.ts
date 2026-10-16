import { randomUUID } from "node:crypto"
import { Deferred, Effect, Fiber, Queue, Stream, Schema } from "effect"
import type { Scope } from "effect"
import type {
  Conversation,
  DeliveryTicket,
  ReplyDeliveryUpdate,
  ResponseInvalidation,
  ResponseTarget
} from "../conversation/index.ts"
import { SynthesisEvent, SynthesisCapabilities } from "../speech-synthesis/index.ts"
import type { SpeechSynthesis } from "../speech-synthesis/index.ts"
import { failed } from "./contracts.ts"
import type {
  AudioManifest,
  VoiceOutput,
  OutputReady,
  OutputInterrupt,
  AudioPublication,
  MediaConnection
} from "./contracts.ts"
import type { Phrase } from "./phrases.ts"
import type { VoiceOutputSettings } from "./output-configuration.ts"
import { Phrases } from "./phrases.ts"
import { disabledVoiceDiagnostics, recordVoiceDiagnostic } from "./diagnostics.ts"
import type { VoiceDiagnostics, VoiceDiagnosticInput } from "./diagnostics.ts"
const sampleRate = 24000
const readinessMillis = 5000
const pollMillis = 20
const maximumError = 1000
const unobservedSequence = -1
const invalidationMessage = (target: ResponseInvalidation, previous: { message: string } | null) =>
  target.reason === "Deadline"
    ? "Reply audio delivery exceeded its deadline"
    : (previous?.message ?? "Reply generation or audio delivery failed")
const invalidationCauses: Record<ResponseInvalidation["reason"], VoiceDiagnosticInput["cause"]> = {
  Interrupted: "conversationInvalidation",
  Deadline: "deadline",
  Failed: "failed",
  Detached: "detach"
}
const diagnosticTarget = (target: ResponseTarget & { outputEpoch?: string }) => ({
  responseId: target.responseId,
  inputDeliveryId: target.inputDeliveryId,
  ...(target.outputEpoch === undefined ? {} : { outputEpoch: target.outputEpoch })
})
export class ReplyAudio {
  #suppressedAdmissions = new Set<string>()
  #ticket: DeliveryTicket | undefined
  #fenced = true
  #state: VoiceOutput | null = null
  #publication: AudioPublication | undefined
  #ready: Deferred.Deferred<void> | undefined
  #registration: string | undefined
  #updates: Fiber.Fiber<void> | undefined
  #sequence = unobservedSequence
  #worker: Fiber.Fiber<void> | undefined
  #notices: Queue.Queue<boolean> | undefined
  constructor(
    readonly sessionId: string,
    readonly conversation: Conversation["Service"],
    readonly synthesis: SpeechSynthesis["Service"],
    readonly connection: MediaConnection,
    readonly scope: Scope.Scope,
    readonly emit: (output: VoiceOutput) => Effect.Effect<void>,
    readonly settings: VoiceOutputSettings,
    readonly diagnostics: VoiceDiagnostics["Service"] = disabledVoiceDiagnostics
  ) {}
  /** Fence an input whose durable admission overlaps newer speech, even before
   * its reply ticket exists. Session retains this fence until that admission settles. */
  suppressDelivery(inputDeliveryId: string) {
    this.#suppressedAdmissions.add(inputDeliveryId)
    if (this.#state?.inputDeliveryId === inputDeliveryId) this.#invalidated({ ...this.#state, reason: "Interrupted" })
  }
  releaseAdmission(inputDeliveryId: string) {
    this.#suppressedAdmissions.delete(inputDeliveryId)
  }
  get snapshot() {
    return this.#state
  }
  #active(ticket: DeliveryTicket) {
    return (
      !this.#fenced &&
      this.#ticket?.deliveryId === ticket.deliveryId &&
      this.conversation.replyDeliveryAuthorization(ticket).isAuthorized()
    )
  }
  #notify() {
    if (this.#notices !== undefined) Queue.offerUnsafe(this.#notices, true)
  }
  trace(
    cause: VoiceDiagnosticInput["cause"],
    applied: boolean,
    target?: ResponseTarget & { outputEpoch?: string },
    generation?: number
  ) {
    const state = target === undefined || this.#matchesTarget(target) ? this.#state : null
    recordVoiceDiagnostic(this.diagnostics, {
      cause,
      applied,
      sessionId: this.sessionId,
      ...(generation === undefined ? {} : { generation }),
      ...(state === null
        ? {}
        : {
            responseId: state.responseId,
            inputDeliveryId: state.inputDeliveryId,
            outputEpoch: state.outputEpoch,
            priorStatus: state.status
          }),
      ...(target === undefined ? {} : diagnosticTarget(target))
    })
  }
  #matchesTarget(target: ResponseTarget) {
    return this.#state?.responseId === target.responseId && this.#state.inputDeliveryId === target.inputDeliveryId
  }
  #invalidated(target: ResponseInvalidation) {
    this.trace(invalidationCauses[target.reason], this.#matchesTarget(target), target)
    if (this.#state?.responseId !== target.responseId) return
    this.#fenced = true
    this.#publication?.invalidate()
    if (["Deadline", "Failed"].includes(target.reason)) {
      this.#state = {
        ...this.#state,
        status: "Failed",
        error: { code: "AudioUnavailable", message: invalidationMessage(target, this.#state.error) }
      }
    } else if (this.#state.status !== "Failed") this.#state = { ...this.#state, status: "Interrupted", error: null }
    this.#notify()
  }
  attach() {
    return Effect.gen({ self: this }, function* () {
      yield* Schema.decodeUnknownEffect(SynthesisCapabilities)(this.synthesis.capabilities).pipe(
        Effect.mapError(() => failed("AudioUnavailable", "Incompatible speech synthesis capabilities"))
      )
      if (!this.synthesis.capabilities.languages.includes("en"))
        return yield* failed("AudioUnavailable", "English speech synthesis is unavailable")
      this.#notices = yield* Queue.make<boolean>({ capacity: 1 })
      yield* Effect.forever(Queue.take(this.#notices).pipe(Effect.andThen(this.#changed()))).pipe(
        Effect.forkIn(this.scope)
      )
      const registration = yield* this.conversation
        .registerReplyDelivery({ completionMillis: this.settings.completionMillis })
        .pipe(Effect.mapError((error) => failed("AudioUnavailable", error.message)))
      this.#registration = registration.registrationId
      this.#updateDelivery(registration.snapshot)
      this.#updates = yield* registration.updates.pipe(
        Stream.runForEach((update) => Effect.sync(() => this.#updateDelivery(update))),
        Effect.forkIn(this.scope)
      )
    })
  }
  #projectTicket(ticket: DeliveryTicket) {
    if (this.#ticket?.deliveryId === ticket.deliveryId) return
    this.#publication?.invalidate()
    this.#ticket = ticket
    this.#fenced = false
    this.#state = {
      responseId: ticket.responseId,
      inputDeliveryId: ticket.inputDeliveryId,
      outputEpoch: randomUUID(),
      status: "Preparing",
      manifest: null,
      error: null
    }
  }
  #delivered() {
    this.#fenced = true
    if (this.#state !== null && this.#state.manifest !== null)
      this.#state = { ...this.#state, manifest: this.#state.manifest, status: "Delivered", error: null }
    this.#notify()
  }
  #updateDelivery(update: ReplyDeliveryUpdate) {
    if (update.registrationId !== this.#registration || update.sequence <= this.#sequence) return
    this.#sequence = update.sequence
    if (update.kind === "Idle") return
    const ticket = update.ticket
    this.#projectTicket(ticket)
    switch (update.kind) {
      case "Invalidated":
        this.#invalidated({ ...ticket, reason: update.reason })
        return
      case "Delivered":
        this.#delivered()
        return
      case "Started":
        if (this.#suppressedAdmissions.has(ticket.inputDeliveryId))
          this.#invalidated({ ...ticket, reason: "Interrupted" })
        else this.#notify()
    }
  }
  #changed() {
    return Effect.gen({ self: this }, function* () {
      this.#publication?.invalidate()
      if (this.#worker !== undefined) yield* Fiber.interrupt(this.#worker)
      const ticket = this.#ticket
      if (ticket === undefined || !this.#active(ticket)) {
        if (this.#state !== null) yield* this.emit(this.#state)
        return
      }
      this.#worker = yield* this.#play(ticket).pipe(
        Effect.catch((error) => this.#failure(ticket, error.message)),
        Effect.forkIn(this.scope)
      )
    })
  }
  #set(ticket: DeliveryTicket, output: VoiceOutput) {
    return Effect.suspend(() => {
      if (!this.#active(ticket)) return Effect.void
      this.#state = output
      return this.emit(output)
    })
  }
  #failure(ticket: DeliveryTicket, message: string) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#active(ticket) || this.#state === null) return
      this.trace("failed", true)
      this.#publication?.invalidate()
      this.#state = {
        ...this.#state,
        status: "Failed",
        error: { code: "AudioUnavailable", message: message.slice(0, maximumError) }
      }
      yield* this.emit(this.#state)
      yield* this.conversation
        .settleReplyDelivery({ ...ticket, outcome: "Failed", error: { code: "AudioUnavailable", message } })
        .pipe(Effect.ignore)
    })
  }
  #validEvent(event: SynthesisEvent, ticket: DeliveryTicket, phraseId: string, sequence: number, completed: boolean) {
    return (
      !completed &&
      event.responseId.toLowerCase() === ticket.responseId &&
      event.phraseId.toLowerCase() === phraseId &&
      event.sequence === sequence
    )
  }
  #reply(ticket: DeliveryTicket) {
    return this.conversation.reply(ticket.inputDeliveryId).pipe(
      Effect.mapError((error) => failed("AudioUnavailable", error.message)),
      Effect.flatMap((reply) => {
        if (reply.responseId !== ticket.responseId) return Effect.interrupt
        return ["Failed", "Interrupted"].includes(reply.state)
          ? Effect.fail(failed("AudioUnavailable", "Reply generation stopped before audio completion"))
          : Effect.succeed(reply)
      })
    )
  }
  #synthesize(ticket: DeliveryTicket, phrase: Phrase, publication: AudioPublication) {
    if (!this.synthesis.capabilities.languages.includes(phrase.language))
      return Effect.fail(failed("AudioUnavailable", "Unsupported reply phrase language"))
    const phraseId = randomUUID()
    let sequence = 0
    let frames = 0
    let completed = false
    return this.synthesis
      .synthesize({ responseId: ticket.responseId, phraseId, language: phrase.language, text: phrase.text })
      .pipe(
        Stream.runForEach((raw) =>
          Schema.decodeUnknownEffect(SynthesisEvent)(raw).pipe(
            Effect.mapError(() => failed("AudioUnavailable", "Invalid synthesis event")),
            Effect.flatMap((event) => {
              if (!this.#active(ticket)) return Effect.interrupt
              if (!this.#validEvent(event, ticket, phraseId, sequence, completed))
                return Effect.fail(failed("AudioUnavailable", "Invalid synthesis identity or sequence"))
              if (event.kind === "Completed") {
                completed = true
                return Effect.void
              }
              sequence += 1
              frames += event.audio.sampleFrames
              return frames > this.synthesis.capabilities.maxAudioFrames
                ? Effect.fail(failed("AudioUnavailable", "Phrase audio exceeds capacity"))
                : publication.capture(event.audio)
            })
          )
        ),
        Effect.mapError((error) => failed("AudioUnavailable", error.message)),
        Effect.andThen(
          Effect.suspend(() =>
            completed && sequence > 0
              ? Effect.void
              : Effect.fail(failed("AudioUnavailable", "Synthesis lacks complete audio"))
          )
        )
      )
  }
  #stream(ticket: DeliveryTicket, publication: AudioPublication) {
    return Effect.gen({ self: this }, function* () {
      const phrases = new Phrases()
      while (this.#active(ticket)) {
        const reply = yield* this.#reply(ticket)
        if (!phrases.append(reply.text, reply.languageSpans, reply.responseLanguage))
          return yield* failed("AudioUnavailable", "Reply text or language annotations changed during playback")
        const flush = reply.state === "Delivering"
        let phrase = phrases.next(flush)
        while (phrase !== undefined) {
          yield* this.#synthesize(ticket, phrase, publication)
          phrase = phrases.next(flush)
        }
        if (flush && phrases.empty) return
        yield* Effect.sleep(pollMillis)
      }
      return yield* Effect.interrupt
    })
  }
  #play(ticket: DeliveryTicket) {
    return Effect.gen({ self: this }, function* () {
      const state = this.#state
      if (state === null) return
      const ready = yield* Deferred.make<void>()
      this.#ready = ready
      yield* Effect.acquireUseRelease(
        this.connection.openOutput(state.outputEpoch, this.conversation.replyDeliveryAuthorization(ticket)),
        (publication) =>
          Effect.gen({ self: this }, function* () {
            if (!this.#active(ticket)) return yield* Effect.interrupt
            this.#publication = publication
            const manifest: AudioManifest = {
              sessionId: this.sessionId,
              responseId: ticket.responseId,
              inputDeliveryId: ticket.inputDeliveryId,
              outputEpoch: state.outputEpoch,
              publisherIdentity: publication.publisherIdentity,
              trackSid: publication.trackSid,
              sourceAudio: { encoding: "pcm-s16le" as const, sampleRateHz: sampleRate, channels: 1 as const }
            }
            yield* this.#set(ticket, { ...state, status: "AwaitingReady", manifest, error: null })
            yield* Deferred.await(ready).pipe(
              Effect.timeout(readinessMillis),
              Effect.mapError(() => failed("AudioUnavailable", "Reply audio readiness exceeded its deadline"))
            )
            if (!this.#active(ticket)) return yield* Effect.interrupt
            yield* this.#set(ticket, { ...state, status: "Playing", manifest, error: null })
            yield* this.#stream(ticket, publication)
            yield* publication.drain()
            if (!this.#active(ticket)) return yield* Effect.interrupt
            yield* this.conversation
              .settleReplyDelivery({ ...ticket, outcome: "Completed" })
              .pipe(Effect.mapError((error) => failed("AudioUnavailable", error.message)))
            yield* this.#set(ticket, { ...state, status: "Delivered", manifest, error: null })
          }),
        (publication) =>
          publication.close().pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (this.#publication === publication) this.#publication = undefined
              })
            )
          )
      )
    })
  }
  ready(input: OutputReady) {
    return Effect.gen({ self: this }, function* () {
      const state = this.#state
      if (
        state === null ||
        state.responseId !== input.responseId ||
        state.outputEpoch !== input.outputEpoch ||
        this.#fenced
      )
        return
      if (state.manifest?.trackSid !== input.trackSid)
        return yield* failed("StaleOutput", "Ready acknowledgement must identify its exact publication")
      if (this.#ready !== undefined) yield* Deferred.succeed(this.#ready, undefined)
    })
  }
  interrupt(input: OutputInterrupt) {
    return Effect.gen({ self: this }, function* () {
      const state = this.#state
      if (
        state === null ||
        state.responseId !== input.responseId ||
        state.inputDeliveryId !== input.inputDeliveryId ||
        state.outputEpoch !== input.outputEpoch ||
        ["Delivered", "Interrupted", "Failed"].includes(state.status)
      ) {
        this.trace("clientInterrupt", false, input)
        return
      }
      this.trace("clientInterrupt", true, input)
      this.#invalidated({ ...input, reason: "Interrupted" })
      yield* this.conversation
        .interruptResponse(input)
        .pipe(Effect.mapError((error) => failed("AudioUnavailable", error.message)))
    })
  }
  speechStarted(generation?: number) {
    const state = this.#state
    const applied = state !== null && !["Delivered", "Interrupted", "Failed"].includes(state.status)
    this.trace("backendSpeech", applied, undefined, generation)
    if (!applied || state === null) return Effect.void
    this.#invalidated({ ...state, reason: "Interrupted" })
    return this.conversation.interruptResponse(state).pipe(
      Effect.mapError((error) => failed("AudioUnavailable", error.message)),
      Effect.asVoid
    )
  }
  retire() {
    const state = this.#state
    if (state !== null && state.status !== "Delivered") this.#invalidated({ ...state, reason: "Detached" })
  }
  close() {
    return Effect.gen({ self: this }, function* () {
      this.retire()
      if (this.#updates !== undefined) yield* Fiber.interrupt(this.#updates)
      if (this.#registration !== undefined)
        yield* this.conversation.unregisterReplyDelivery(this.#registration).pipe(Effect.ignore)
      this.#publication?.invalidate()
      if (this.#worker !== undefined) yield* Fiber.interrupt(this.#worker)
    })
  }
}
