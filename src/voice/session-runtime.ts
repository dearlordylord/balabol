import { Deferred, Effect, Queue, Scope, Exit, Schema } from "effect"
import type { Fiber } from "effect"
import type { InputSource } from "../conversation/index.ts"
import type { SessionDependencies, SessionIdentity, SessionRetention } from "./session-port.ts"
import type { SessionEvent, SessionCommand } from "./session-events.ts"
import { initialSession, pendingCount, sessionSnapshot } from "./session-state.ts"
import type { SessionState } from "./session-state.ts"
import { transitionSession } from "./session-transitions.ts"
import { VoiceFrame, failed } from "./contracts.ts"
import type { VoiceFailed, MediaConnection, OutputReady, OutputInterrupt } from "./contracts.ts"
import type { ActivityStream } from "./activity.ts"
import { makeOutputExecutor } from "./output-executor.ts"
import { makeSessionExpiryExecutor } from "./session-expiry-executor.ts"
import type { OutputDecision } from "./output-state.ts"
import { makeRecognitionExecutor } from "./recognition-executor.ts"
import { makeSessionAdmissions } from "./session-admissions.ts"
import { recordSessionEventDiagnostic } from "./session-diagnostics.ts"
import { recordVoiceDiagnostic } from "./diagnostics.ts"
import type { VoiceDiagnosticInput } from "./diagnostics.ts"
type DirectCommand = Extract<
  SessionCommand,
  { kind: "ResetCapture" | "FenceSpeech" | "OutputWork" | "ScheduleExpiry" | "CancelExpiry" }
>
type WorkCommand = Exclude<SessionCommand, DirectCommand>
type MetadataCommand = Extract<
  WorkCommand,
  { kind: "CancelAcquisition" | "TraceEvent" | "TraceRecognition" | "TraceOutput" }
>
const retentionChanged = (before: SessionState, after: SessionState) =>
  before.phase !== after.phase ||
  pendingCount(before) !== pendingCount(after) ||
  before.releasePending.length !== after.releasePending.length
const datagramPublishMillis = 250
interface Envelope {
  readonly event: SessionEvent
  readonly ack: Deferred.Deferred<SessionAcknowledgement, VoiceFailed>
}
interface SessionAcknowledgement {
  readonly state: SessionState
  readonly outputDecision?: OutputDecision
}
interface CaptureFrame {
  readonly track: string
  readonly frame: VoiceFrame
  readonly generation: number
}
export const makeSessionRuntime = (
  deps: SessionDependencies,
  identity: SessionIdentity,
  muted: boolean,
  startedAt: number,
  captureScope: Scope.Closeable,
  activity: ActivityStream,
  source: InputSource,
  sourceRelease: Effect.Effect<void>,
  retention: (fact: SessionRetention) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make()
    let state = initialSession(
      identity.sessionId,
      deps.admissions.backendIncarnationId,
      muted,
      startedAt,
      deps.languages.allowedLanguages,
      {
        sessionId: identity.sessionId,
        languages: [...deps.synthesis.capabilities.languages],
        maxAudioFrames: deps.synthesis.capabilities.maxAudioFrames,
        completionMillis: deps.outputSettings.completionMillis
      }
    )
    let retired = false
    let revision = 0
    let connection: MediaConnection | undefined
    let acquisition: Fiber.Fiber<unknown, unknown> | undefined
    const mailbox = yield* Queue.unbounded<Envelope>()
    const frames = yield* Queue.make<CaptureFrame>({ capacity: 8 })
    const closed = yield* Deferred.make<void>()
    const acquired = yield* Deferred.make<void>()
    let frameOperation = 0
    const notify = (event: SessionEvent) => {
      if (retired) return
      Queue.offerUnsafe(mailbox, { event, ack: Deferred.makeUnsafe<SessionAcknowledgement, VoiceFailed>() })
    }
    const expiry = makeSessionExpiryExecutor(ownerScope, notify)
    const idleWaiters = new Set<Deferred.Deferred<void>>()
    const pending = new Set<Deferred.Deferred<SessionAcknowledgement, VoiceFailed>>()
    const request = (event: SessionEvent) =>
      Effect.gen(function* () {
        if (retired) return yield* failed("SessionNotFound", "Voice session has been disposed")
        const ack = yield* Deferred.make<SessionAcknowledgement, VoiceFailed>()
        pending.add(ack)
        yield* Queue.offer(mailbox, { event, ack })
        return yield* Deferred.await(ack).pipe(Effect.ensuring(Effect.sync(() => pending.delete(ack))))
      })
    const post = (event: SessionEvent) => request(event).pipe(Effect.map((ack) => ack.state))
    const output = makeOutputExecutor({
      conversation: deps.conversation,
      synthesis: deps.synthesis,
      connection: () => connection,
      scope: ownerScope,
      current: () => state.output,
      sessionId: identity.sessionId,
      diagnostics: deps.diagnostics,
      post: (input) =>
        request({ kind: "Output", input }).pipe(Effect.map((ack) => ack.outputDecision ?? { kind: "Ignored" }))
    })
    const trace = (cause: VoiceDiagnosticInput["cause"], samples?: number, generation = state.generation) =>
      recordVoiceDiagnostic(deps.diagnostics, {
        cause,
        applied: true,
        sessionId: state.id,
        generation,
        ...(samples === undefined ? {} : { sampleFrames: samples })
      })
    const admission = makeSessionAdmissions(
      deps,
      state.id,
      source,
      sourceRelease,
      post,
      () => state,
      () => connection
    )
    const recognition = makeRecognitionExecutor(
      deps.provider,
      deps.languages.allowedLanguages,
      captureScope,
      (input) => post({ kind: "Recognition", input }).pipe(Effect.asVoid, Effect.ignore),
      (job) =>
        state.recognition.jobs.some(
          (current) =>
            current.operation === job.operation && current.generation === job.generation && current.status === "Running"
        )
    )
    const report = () => {
      const fact: SessionRetention = {
        sessionId: state.id,
        revision: ++revision,
        status: state.phase === "starting" ? "active" : state.phase,
        pendingAdmissions: pendingCount(state),
        releaseComplete: state.phase === "ended" && state.releasePending.length === 0
      }
      return retention(fact)
    }
    const releaseResource = (resource: string) => {
      switch (resource) {
        case "capture":
          return recognition.close().pipe(Effect.andThen(Scope.close(captureScope, Exit.void)))
        case "connection":
          return Deferred.await(acquired).pipe(Effect.andThen(Effect.suspend(() => connection?.close() ?? Effect.void)))
        case "output":
          return output.close()
        case "source":
          return admission.closeSource()
        default:
          return Effect.die("Unknown session release obligation")
      }
    }
    const fork = (effect: Effect.Effect<void>) => effect.pipe(Effect.forkIn(ownerScope), Effect.asVoid)
    const executeMetadata = (command: MetadataCommand): Effect.Effect<void> => {
      switch (command.kind) {
        case "CancelAcquisition":
          return Effect.sync(cancelAcquisition)
        case "TraceEvent":
          return Effect.sync(() => recordSessionEventDiagnostic(deps.diagnostics, state, command))
        case "TraceRecognition":
          return Effect.sync(() => trace(command.cause, command.sampleFrames, command.generation))
        case "TraceOutput":
          return Effect.sync(() => recordVoiceDiagnostic(deps.diagnostics, command.input))
      }
    }
    const executeWork = (command: WorkCommand): Effect.Effect<void> => {
      switch (command.kind) {
        case "RecognitionWork":
          return recognition.execute(command.command)
        case "Publish":
          return fork(
            connection?.publish(command.event).pipe(Effect.timeout(datagramPublishMillis), Effect.ignore) ?? Effect.void
          )
        case "BeginAdmission":
          return admission.begin(command.input, command.sourceSequence)
        case "SubmitAdmission":
          return admission.submit(command.id, command.event).pipe(Effect.forkIn(deps.hostScope), Effect.asVoid)
        case "Release":
          return fork(
            releaseResource(command.resource).pipe(
              Effect.andThen(post({ kind: "Released", resource: command.resource })),
              Effect.asVoid,
              Effect.ignore
            )
          )
        default:
          return executeMetadata(command)
      }
    }
    const fenceSpeech = (command: Extract<SessionCommand, { kind: "FenceSpeech" }>): Effect.Effect<void> => {
      return fork(
        deps.conversation
          .fenceSpeech({ capability: source, sequence: command.sequence, fenceId: command.fenceId })
          .pipe(
            Effect.flatMap((ack) =>
              post({
                kind: "FenceApplied",
                fenceId: command.fenceId,
                generation: command.generation,
                sequence: command.sequence,
                revision: ack.revision
              })
            ),
            Effect.catch((error) =>
              post({
                kind: "FenceRejected",
                fenceId: command.fenceId,
                generation: command.generation,
                sequence: command.sequence,
                message: error.message
              })
            ),
            Effect.asVoid,
            Effect.ignore
          )
      )
    }
    const cancelAcquisition = () => {
      if (acquisition !== undefined) acquisition.interruptUnsafe()
    }
    const execute = (command: SessionCommand): Effect.Effect<void> => {
      switch (command.kind) {
        case "ScheduleExpiry":
        case "CancelExpiry":
          return expiry(command)
        case "OutputWork":
          return output.execute(command.command)
        case "ResetCapture":
          return Effect.sync(() => activity.reset())
        case "FenceSpeech":
          return fenceSpeech(command)
        default:
          return executeWork(command)
      }
    }
    const consume = (envelope: Envelope) =>
      Effect.gen(function* () {
        const before = state
        const result = transitionSession(state, envelope.event)
        state = result.state
        yield* Effect.forEach(result.commands, execute, { discard: true })
        if (retentionChanged(before, state)) yield* fork(report())
        if (state.phase === "ended") yield* Deferred.succeed(closed, undefined)
        if (state.admitting.length === 0) {
          yield* Effect.forEach(idleWaiters, (done) => Deferred.succeed(done, undefined), { discard: true })
          idleWaiters.clear()
        }
        if (result.error === undefined)
          yield* Deferred.succeed(envelope.ack, {
            state,
            ...(result.outputDecision === undefined ? {} : { outputDecision: result.outputDecision })
          })
        else yield* Deferred.fail(envelope.ack, result.error)
      })
    yield* Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(consume))).pipe(Effect.forkIn(ownerScope))
    const frame = (value: CaptureFrame) =>
      Effect.gen(function* () {
        const operation = ++frameOperation
        const next = yield* post({
          kind: "Frame",
          operation,
          generation: value.generation,
          track: value.track,
          samples: value.frame.samplesPerChannel
        })
        if (next.classification?.operation !== operation) return
        const generation = next.generation
        yield* Effect.suspend(() =>
          state.classification?.operation === operation ? activity.push(value.frame) : Effect.succeed([])
        ).pipe(
          Effect.flatMap((windows) => recognition.classified(windows, generation)),
          Effect.catch((error) =>
            post({ kind: "CaptureFailed", generation, operation, code: error.code, message: error.message }).pipe(
              Effect.asVoid,
              Effect.ignore
            )
          ),
          Effect.ensuring(Effect.sync(() => notify({ kind: "Classified", operation })))
        )
      })
    yield* Effect.forever(Queue.take(frames).pipe(Effect.flatMap(frame))).pipe(Effect.forkIn(captureScope))
    const incoming = (track: string, raw: unknown) => {
      if (retired || state.phase !== "active" || state.muted || state.retiredTracks.includes(track)) return
      const parsed = Schema.decodeUnknownExit(VoiceFrame)(raw)
      if (Exit.isFailure(parsed)) {
        notify({
          kind: "CaptureFailed",
          generation: state.generation,
          operation: null,
          code: "InvalidAudio",
          message: "Expected 16 kHz mono 20 ms PCM audio"
        })
        return
      }
      const value = parsed.value
      const frame = { ...value, data: value.data.slice() }
      if (!Queue.offerUnsafe(frames, { track, frame, generation: state.generation })) {
        trace("queueOverflow")
        notify({ kind: "Disconnected", code: "Overloaded" })
      }
    }
    const close = () =>
      Effect.suspend(() =>
        state.phase === "ended" ? Effect.void : post({ kind: "End" }).pipe(Effect.andThen(Deferred.await(closed)))
      )
    const idle = Effect.suspend(() => {
      if (state.admitting.length === 0) return Effect.void
      const done = Deferred.makeUnsafe<void>()
      idleWaiters.add(done)
      return Deferred.await(done)
    })
    const dispose = () =>
      Effect.gen(function* () {
        if (retired) return
        yield* close().pipe(Effect.ignore)
        yield* idle
        retired = true
        yield* Effect.forEach(
          pending,
          (ack) => Deferred.fail(ack, failed("SessionNotFound", "Voice session is shutting down")),
          { discard: true }
        )
        yield* Scope.close(ownerScope, Exit.void)
      })
    yield* Effect.addFinalizer(dispose).pipe(Effect.provideService(Scope.Scope, deps.hostScope))
    return {
      post,
      current: () => state,
      snapshot: (after: number) => sessionSnapshot(state, after),
      incoming,
      joined: () => {
        notify({ kind: "Joined" })
      },
      disconnected: () => {
        notify({ kind: "Disconnected", code: "MediaDisconnected" })
      },
      attach: (media: MediaConnection) =>
        Effect.gen(function* () {
          connection = media
          if (state.phase !== "starting" && state.phase !== "active") return
          yield* post({ kind: "Output", input: { kind: "Attach" } })
          yield* output.awaitAttached
        }),
      installAcquisition: (fiber: Fiber.Fiber<unknown, unknown>) =>
        Effect.sync(() => {
          acquisition = fiber
          if (state.phase === "closing" || state.phase === "ended") cancelAcquisition()
        }),
      acquisitionFinished: Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
      ready: (input: OutputReady) => post({ kind: "Output", input: { kind: "Ready", input } }).pipe(Effect.asVoid),
      interrupt: (input: OutputInterrupt) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const ack = yield* request({ kind: "Output", input: { kind: "Interrupt", input } })
            const decision = ack.outputDecision
            if (decision?.kind !== "Applied" || decision.operation === undefined) return
            const completed = yield* output.consumeAck(decision.operation)
            yield* restore(completed)
          })
        ),
      reconcile: admission.reconcile,
      close,
      dispose,
      awaitClosed: Deferred.await(closed)
    }
  })
