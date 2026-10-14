import { Context, Effect, Layer, Schema, Queue, Redacted, Scope, Exit, Semaphore } from "effect"
import { Conversation } from "../conversation/index.ts"
import { SpeechRecognition } from "../speech-recognition/index.ts"
import { SpeechSynthesis } from "../speech-synthesis/index.ts"
import { VoiceTransport, SessionId, OutputReady, OutputInterrupt, failed } from "./contracts.ts"
import type { VoiceJoin, VoiceSnapshot, VoiceFailed } from "./contracts.ts"
import { Session } from "./session.ts"
import { ReplyAudio } from "./output.ts"
const maximumSessions = 2
const disconnectPollMillis = 20
export class Voice extends Context.Service<
  Voice,
  {
    authorize: (id: string, token: string) => Effect.Effect<void, VoiceFailed>
    start: () => Effect.Effect<VoiceJoin, VoiceFailed>
    snapshot: (id: string, after: number) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    mute: (id: string, muted: boolean) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    ready: (id: string, input: OutputReady) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    interrupt: (id: string, input: OutputInterrupt) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    end: (id: string) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  }
>()("balabol/voice") {
  static readonly layer = Layer.effect(
    Voice,
    Effect.gen(function* () {
      const conversation = yield* Conversation
      const provider = yield* SpeechRecognition
      const synthesis = yield* SpeechSynthesis
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
          session.audio?.retire()
          yield* session.connection?.close() ?? Effect.void
          yield* session.audio?.close() ?? Effect.void
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
            session.audio = new ReplyAudio(
              session.id,
              conversation,
              synthesis,
              opened.connection,
              sessionScope,
              (output) => session.emit({ kind: "Output", output })
            )
            yield* session.audio.attach().pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  session.status = "ended"
                }).pipe(Effect.andThen(opened.connection.close()), Effect.andThen(session.release))
              )
            )
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
        ready: (id, raw) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              Schema.decodeUnknownEffect(OutputReady)(raw).pipe(
                Effect.mapError(() => failed("InvalidInput", "Invalid output readiness")),
                Effect.flatMap((input) => session.audio?.ready(input) ?? Effect.void),
                Effect.map(() => session.snapshot(0))
              )
            )
          ),
        interrupt: (id, raw) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              Schema.decodeUnknownEffect(OutputInterrupt)(raw).pipe(
                Effect.mapError(() => failed("InvalidInput", "Invalid output interruption")),
                Effect.flatMap((input) => session.audio?.interrupt(input) ?? Effect.void),
                Effect.map(() => session.snapshot(0))
              )
            )
          ),
        end: (id) => get(id).pipe(Effect.flatMap(end))
      })
    })
  )
}
