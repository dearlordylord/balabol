import { Context, Effect, Layer, Schema, Clock, Queue, Redacted, Scope, Exit, Semaphore, Option } from "effect"
import { Conversation } from "../conversation/index.ts"
import { SpeechRecognition } from "../speech-recognition/index.ts"
import { SpeechSynthesis } from "../speech-synthesis/index.ts"
import { VoiceTransport, SessionId, OutputReady, OutputInterrupt, failed } from "./contracts.ts"
import type { VoiceJoin, VoiceSnapshot, VoiceFailed } from "./contracts.ts"
import { StartVoiceRequest, ResolveSpeechAdmissions } from "./recovery-contracts.ts"
import type { SpeechResolutions } from "./recovery-contracts.ts"
import { VoiceAdmissions, speechPayloadHash, speechAnnotationsHash, speechDetectionHash } from "./admissions.ts"
import { VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration, validateVoiceLanguages } from "./languages.ts"
import type { VoiceLanguageCapabilities } from "./languages.ts"
import { Session } from "./session.ts"
import { VoiceOutputSettings, VoiceOutputConfiguration, defaultVoiceOutputSettings } from "./output-configuration.ts"
import { SpeechActivity, fakeSpeechActivityLayer } from "./activity.ts"
import { ReplyAudio } from "./output.ts"
import { VoiceDiagnostics, disabledVoiceDiagnostics, recordVoiceDiagnostic } from "./diagnostics.ts"
const maximumSessions = 2
const disconnectPollMillis = 20
const joinMillis = 10000
const controlMillis = 30000
export class Voice extends Context.Service<
  Voice,
  {
    languages: () => Effect.Effect<VoiceLanguageCapabilities>
    authorize: (id: string, token: string) => Effect.Effect<void, VoiceFailed>
    start: (request: StartVoiceRequest) => Effect.Effect<VoiceJoin, VoiceFailed>
    resolve: (request: ResolveSpeechAdmissions) => Effect.Effect<SpeechResolutions, VoiceFailed>
    snapshot: (id: string, after: number) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    mute: (id: string, muted: boolean) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    ready: (id: string, input: OutputReady) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    interrupt: (id: string, input: OutputInterrupt) => Effect.Effect<VoiceSnapshot, VoiceFailed>
    end: (id: string) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  }
>()("balabol/voice") {
  static readonly configuredLayer = Layer.effect(
    Voice,
    Effect.gen(function* () {
      const diagnostics = Option.getOrElse(
        yield* Effect.serviceOption(VoiceDiagnostics),
        () => disabledVoiceDiagnostics
      )
      const languageSettings = yield* VoiceLanguageConfiguration
      const outputSettings = yield* Schema.decodeUnknownEffect(VoiceOutputSettings)(
        yield* VoiceOutputConfiguration
      ).pipe(Effect.mapError(() => failed("InvalidInput", "Invalid reply audio completion deadline")))
      const admissions = yield* VoiceAdmissions
      const conversation = yield* Conversation
      const provider = yield* SpeechRecognition
      const activity = yield* SpeechActivity
      const synthesis = yield* SpeechSynthesis
      const languages = yield* validateVoiceLanguages(
        languageSettings,
        provider.capabilities,
        synthesis.capabilities,
        conversation.replyLanguages
      )
      const transport = yield* VoiceTransport
      const scope = yield* Effect.scope
      const sessions = new Map<string, { session: Session; join: Redacted.Redacted<VoiceJoin> }>()
      const starts = yield* Semaphore.make(1)
      const get = (id: string) =>
        Schema.decodeUnknownEffect(SessionId)(id).pipe(
          Effect.mapError(() => failed("InvalidSession", "Invalid session identity")),
          Effect.flatMap((parsed) => {
            const session = sessions.get(parsed.toLowerCase())?.session
            return session === undefined
              ? Effect.fail(failed("SessionNotFound", "Voice session unavailable"))
              : expire(session).pipe(Effect.as(session))
          })
        )
      const end = (session: Session) =>
        Effect.gen(function* () {
          if (session.status === "ended") return session.snapshot(0)
          recordVoiceDiagnostic(diagnostics, {
            cause: "lifecycle",
            sessionId: session.id,
            applied: true,
            generation: session.generation
          })
          session.status = "ended"
          session.audio?.retire()
          yield* session.stop()
          yield* session.connection?.close() ?? Effect.void
          yield* session.audio?.close() ?? Effect.void
          yield* session.release
          yield* session.emit({ kind: "Ended" })
          return session.snapshot(0)
        })
      const expire = (session: Session) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            session.status === "active" &&
            ((!session.joined && now >= session.joinDeadlineAt) || now >= session.controlDeadlineAt)
              ? end(session).pipe(Effect.asVoid)
              : Effect.void
          )
        )
      const renew = (session: Session) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((now) =>
            Effect.sync(() => {
              if (session.status === "active") session.controlDeadlineAt = now + controlMillis
            })
          ),
          Effect.asVoid
        )
      yield* Effect.addFinalizer(() =>
        Effect.forEach(sessions.values(), (record) => end(record.session), { discard: true })
      )
      return Voice.of({
        languages: () => Effect.succeed(languages),
        authorize: (id, token) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              token === Redacted.value(session.controlToken)
                ? Effect.void
                : Effect.fail(failed("Unauthorized", "Invalid session capability"))
            )
          ),
        start: (raw) =>
          Effect.gen(function* () {
            const request = yield* Schema.decodeUnknownEffect(StartVoiceRequest)(raw).pipe(
              Effect.mapError(() => failed("InvalidInput", "Invalid voice start payload"))
            )
            const prior = [...sessions.values()].find(
              (record) => record.session.startRequestId === request.startRequestId
            )
            if (prior !== undefined) {
              yield* expire(prior.session)
              if (prior.session.initialMuted !== request.muted)
                return yield* failed("StartConflict", "Voice start identity has another initial mute intent")
              if (prior.session.status !== "active")
                return yield* failed("StartExpired", "The original voice session has ended")
              return Redacted.value(prior.join)
            }
            if ([...sessions.values()].some((record) => record.session.status === "active"))
              return yield* failed("VoiceBusy", "A voice session is already active")
            if (sessions.size >= maximumSessions) {
              const ended = [...sessions.values()].find(
                (record) => record.session.status === "ended" && record.session.admissions === 0
              )
              if (ended === undefined) return yield* failed("VoiceBusy", "Previous acceptance is still pending")
              sessions.delete(ended.session.id)
            }
            const sessionScope = yield* Scope.fork(scope)
            const activityStream = yield* activity.open().pipe(Scope.provide(sessionScope))
            const session = new Session(
              conversation,
              provider,
              scope,
              admissions,
              request.startRequestId,
              request.muted,
              languages.allowedLanguages,
              activityStream
            )
            const startedAt = yield* Clock.currentTimeMillis
            session.joinDeadlineAt = startedAt + joinMillis
            session.controlDeadlineAt = startedAt + controlMillis
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
                  if (disconnected !== undefined) return
                  if (!Queue.offerUnsafe(frames, { track, raw, generation: session.generation })) {
                    recordVoiceDiagnostic(diagnostics, {
                      cause: "queueOverflow",
                      sessionId: session.id,
                      applied: true,
                      generation: session.generation
                    })
                    session.fenceInput()
                    disconnected = "Overloaded"
                  }
                },
                () => {
                  disconnected = "MediaDisconnected"
                },
                () => {
                  session.joined = true
                }
              )
              .pipe(Effect.onError(() => session.release))
            yield* Effect.gen(function* () {
              while (session.status === "active") {
                yield* Effect.sleep(disconnectPollMillis)
                const now = yield* Clock.currentTimeMillis
                if ((!session.joined && now >= session.joinDeadlineAt) || now >= session.controlDeadlineAt)
                  disconnected = "SessionExpired"
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
              (output) => session.emit({ kind: "Output", output }),
              outputSettings,
              diagnostics
            )
            yield* session.audio.attach().pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  session.status = "ended"
                }).pipe(Effect.andThen(opened.connection.close()), Effect.andThen(session.release))
              )
            )
            const join = {
              ...opened.join,
              backendIncarnationId: session.backendIncarnationId,
              startRequestId: session.startRequestId,
              joinDeadlineAt: session.joinDeadlineAt,
              controlDeadlineAt: session.controlDeadlineAt,
              controlToken: Redacted.value(session.controlToken)
            }
            sessions.set(session.id, { session, join: Redacted.make(join) })
            return join
          }).pipe(starts.withPermits(1)),
        resolve: (raw) =>
          Schema.decodeUnknownEffect(ResolveSpeechAdmissions)(raw).pipe(
            Effect.mapError(() => failed("InvalidInput", "Invalid speech recovery identities")),
            Effect.flatMap((request) =>
              Effect.forEach(request.admissions, (association) =>
                admissions.find(association).pipe(
                  Effect.flatMap((checkpoint) => {
                    if (checkpoint === null)
                      return Effect.succeed({ ...association, status: "Unknown" as const, receipt: null })
                    return conversation
                      .receipt(association.deliveryId)
                      .pipe(
                        Effect.map((receipt) =>
                          receipt !== null &&
                          receipt.role === "user" &&
                          speechPayloadHash(receipt.text) === checkpoint.payloadHash &&
                          speechAnnotationsHash(receipt.languageSpans) === checkpoint.languageSpansHash &&
                          speechDetectionHash(receipt.detectedLanguage) === checkpoint.detectedLanguageHash
                            ? { ...association, status: "Accepted" as const, receipt }
                            : {
                                ...association,
                                status: checkpoint.state === "Sealed" ? ("NotAccepted" as const) : ("Unknown" as const),
                                receipt: null
                              }
                        )
                      )
                  }),
                  Effect.catch(() => Effect.succeed({ ...association, status: "Unknown" as const, receipt: null }))
                )
              ).pipe(Effect.map((results) => ({ admissions: results })))
            )
          ),
        snapshot: (id, after) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              session.reconcile().pipe(
                Effect.andThen(renew(session)),
                Effect.map(() => session.snapshot(after))
              )
            )
          ),
        mute: (id, muted) =>
          get(id).pipe(
            Effect.flatMap((session) =>
              Effect.gen(function* () {
                yield* renew(session)
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
                Effect.andThen(renew(session)),
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
                Effect.andThen(renew(session)),
                Effect.map(() => session.snapshot(0))
              )
            )
          ),
        end: (id) => get(id).pipe(Effect.flatMap(end))
      })
    })
  )
  static readonly layer = Voice.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeSpeechActivityLayer,
        Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
        Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings)
      )
    )
  )
}
