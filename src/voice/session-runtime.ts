import { Deferred, Effect, Queue, Scope, Exit, Schema } from "effect"
import type { Fiber } from "effect"
import type { InputSource } from "../conversation/index.ts"
import type { SessionDependencies, SessionIdentity, SessionRetention } from "./session-port.ts"
import type { SessionEvent, SessionCommand } from "./session-events.ts"
import { initialSession, pendingCount, sessionSnapshot } from "./session-state.ts"
import type { SessionState } from "./session-state.ts"
import { transitionSession } from "./session-transitions.ts"
import { VoiceFrame, failed } from "./contracts.ts"
import type { VoiceFailed, MediaConnection } from "./contracts.ts"
import type { ActivityStream } from "./activity.ts"
import { ReplyAudio } from "./output.ts"
import { makeSessionRecognition } from "./session-recognition.ts"
import { makeSessionAdmissions } from "./session-admissions.ts"
import { recordSessionEventDiagnostic } from "./session-diagnostics.ts"
import { recordVoiceDiagnostic } from "./diagnostics.ts"
import type { VoiceDiagnosticInput } from "./diagnostics.ts"
type DirectCommand = Extract<
  SessionCommand,
  { kind: "ResetCapture" | "RetireOutput" | "ReleaseAdmission" | "FenceSpeech" }
>
type WorkCommand = Exclude<SessionCommand, DirectCommand>
type MetadataCommand = Extract<WorkCommand, { kind: "CancelAcquisition" | "TraceEvent" }>
const retentionChanged = (before: SessionState, after: SessionState) =>
  before.phase !== after.phase ||
  pendingCount(before) !== pendingCount(after) ||
  before.releasePending.length !== after.releasePending.length
const datagramPublishMillis = 250
interface Envelope {
  readonly event: SessionEvent
  readonly ack: Deferred.Deferred<SessionState, VoiceFailed>
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
    let state = initialSession(identity.sessionId, deps.admissions.backendIncarnationId, muted, startedAt)
    let retired = false
    let revision = 0
    let connection: MediaConnection | undefined
    let audio: ReplyAudio | undefined
    let acquisition: Fiber.Fiber<unknown, unknown> | undefined
    const mailbox = yield* Queue.unbounded<Envelope>()
    const frames = yield* Queue.make<CaptureFrame>({ capacity: 8 })
    const closed = yield* Deferred.make<void>()
    const acquired = yield* Deferred.make<void>()
    let frameOperation = 0
    const notify = (event: SessionEvent) => {
      if (retired) return
      Queue.offerUnsafe(mailbox, { event, ack: Deferred.makeUnsafe<SessionState, VoiceFailed>() })
    }
    const idleWaiters = new Set<Deferred.Deferred<void>>()
    const pending = new Set<Deferred.Deferred<SessionState, VoiceFailed>>()
    const post = (event: SessionEvent) =>
      Effect.gen(function* () {
        if (retired) return yield* failed("SessionNotFound", "Voice session has been disposed")
        const ack = yield* Deferred.make<SessionState, VoiceFailed>()
        pending.add(ack)
        yield* Queue.offer(mailbox, { event, ack })
        return yield* Deferred.await(ack).pipe(Effect.ensuring(Effect.sync(() => pending.delete(ack))))
      })
    const trace = (cause: VoiceDiagnosticInput["cause"], samples?: number) =>
      recordVoiceDiagnostic(deps.diagnostics, {
        cause,
        applied: true,
        sessionId: state.id,
        generation: state.generation,
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
    const speech = (generation: number, fenceId: string) =>
      post({ kind: "Speech", generation, fenceId }).pipe(
        Effect.flatMap((next) => {
          const fence = next.speechFences.find((item) => item.fenceId === fenceId)
          return fence === undefined
            ? Effect.fail(failed("InvalidInput", "Speech onset is no longer current"))
            : Effect.succeed({ generation, fenceId, sourceSequence: fence.sequence })
        })
      )
    const recognition = makeSessionRecognition(
      deps.provider,
      deps.languages.allowedLanguages,
      captureScope,
      activity,
      post,
      () => state,
      speech,
      trace
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
          return Deferred.await(acquired).pipe(Effect.andThen(Effect.suspend(() => audio?.close() ?? Effect.void)))
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
      }
    }
    const executeWork = (command: WorkCommand): Effect.Effect<void> => {
      switch (command.kind) {
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
      for (const id of command.suppress) audio?.suppressDelivery(id)
      const interrupted = audio?.speechStarted(command.generation) ?? Effect.void
      return fork(interrupted.pipe(Effect.ignore)).pipe(
        Effect.andThen(
          fork(
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
        )
      )
    }
    const cancelAcquisition = () => {
      if (acquisition !== undefined) acquisition.interruptUnsafe()
    }
    const execute = (command: SessionCommand): Effect.Effect<void> => {
      switch (command.kind) {
        case "ResetCapture":
          return Effect.sync(() => recognition.reset())
        case "RetireOutput":
          return Effect.sync(() => {
            audio?.retire()
            const output = audio?.snapshot
            if (output != null) notify({ kind: "Output", output })
            trace("lifecycle")
          })
        case "ReleaseAdmission":
          return Effect.sync(() => audio?.releaseAdmission(command.id))
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
        if (result.error === undefined) yield* Deferred.succeed(envelope.ack, state)
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
          audio = new ReplyAudio(
            state.id,
            deps.conversation,
            deps.synthesis,
            media,
            captureScope,
            (output) => post({ kind: "Output", output }).pipe(Effect.asVoid, Effect.ignore),
            deps.outputSettings,
            deps.diagnostics
          )
          yield* audio.attach()
          if (state.phase !== "starting" && state.phase !== "active") audio.retire()
        }),
      installAcquisition: (fiber: Fiber.Fiber<unknown, unknown>) =>
        Effect.sync(() => {
          acquisition = fiber
          if (state.phase === "closing" || state.phase === "ended") cancelAcquisition()
        }),
      acquisitionFinished: Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
      ready: (input: Parameters<ReplyAudio["ready"]>[0]) => audio?.ready(input) ?? Effect.void,
      interrupt: (input: Parameters<ReplyAudio["interrupt"]>[0]) => audio?.interrupt(input) ?? Effect.void,
      reconcile: admission.reconcile,
      close,
      dispose,
      awaitClosed: Deferred.await(closed)
    }
  })
