import { Deferred, Effect } from "effect"
import type { InputSource, InputReservation } from "../conversation/index.ts"
import type { VoiceEvent, VoiceFailed, MediaConnection } from "./contracts.ts"
import type { SessionDependencies } from "./session-port.ts"
import type { SpeechPayload, SessionState } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
const datagramPublishMillis = 250
export const makeSessionAdmissions = (
  deps: SessionDependencies,
  sessionId: string,
  source: InputSource,
  sourceRelease: Effect.Effect<void>,
  post: (event: SessionEvent) => Effect.Effect<SessionState, VoiceFailed>,
  current: () => SessionState,
  connection: () => MediaConnection | undefined
) => {
  const reservations = new Map<string, InputReservation>()
  const registrations = new Map<string, Deferred.Deferred<void>>()
  const association = (id: string) => ({
    backendIncarnationId: deps.admissions.backendIncarnationId,
    sessionId,
    deliveryId: id
  })
  const finish = (id: string) =>
    deps.admissions.seal(association(id)).pipe(
      Effect.ignore,
      Effect.andThen(post({ kind: "AdmissionFinished", id })),
      Effect.andThen(
        Effect.sync(() => {
          reservations.delete(id)
          registrations.delete(id)
        })
      ),
      Effect.asVoid,
      Effect.ignore
    )
  const admissionError = (id: string, error: { message: string; _tag: string }, handed: boolean) =>
    post({ kind: "AdmissionFailed", id, code: error._tag, message: error.message, handed }).pipe(
      Effect.asVoid,
      Effect.ignore
    )
  const begin = (input: SpeechPayload, sourceSequence: number) => {
    const registered = Deferred.makeUnsafe<void>()
    registrations.set(input.id, registered)
    const workflow = Effect.gen(function* () {
      const reservation = yield* deps.conversation
        .registerInput({
          message: {
            deliveryId: input.id,
            text: input.text,
            languageSpans: input.languageSpans,
            detectedLanguage: input.detectedLanguage
          },
          source: { capability: source, sequence: sourceSequence }
        })
        .pipe(Effect.ensuring(Deferred.succeed(registered, undefined)))
      reservations.set(input.id, reservation)
      yield* deps.admissions
        .begin({
          ...association(input.id),
          text: input.text,
          languageSpans: input.languageSpans,
          detectedLanguage: input.detectedLanguage
        })
        .pipe(Effect.onError(() => deps.conversation.abandonInput(reservation).pipe(Effect.ignore)))
      yield* post({ kind: "Prepared", input })
    }).pipe(Effect.catch((error) => admissionError(input.id, error, false).pipe(Effect.andThen(finish(input.id)))))
    return workflow.pipe(Effect.uninterruptible, Effect.forkIn(deps.hostScope), Effect.asVoid)
  }
  const submit = (id: string, event: VoiceEvent) =>
    Effect.gen(function* () {
      const reservation = reservations.get(id)
      if (reservation === undefined) return yield* Effect.die("Missing reserved voice admission")
      if (current().phase === "active")
        yield* connection()?.publish(event).pipe(Effect.timeout(datagramPublishMillis), Effect.ignore) ?? Effect.void
      yield* deps.conversation.submitInput(reservation).pipe(
        Effect.flatMap((receipt) => post({ kind: "Accepted", id, receipt })),
        Effect.catch((error) => admissionError(id, error, true)),
        Effect.ensuring(finish(id))
      )
      reservations.delete(id)
      registrations.delete(id)
    }).pipe(Effect.uninterruptible)
  return {
    begin,
    submit,
    closeSource: () =>
      Effect.gen(function* () {
        yield* Effect.forEach([...registrations.values()], Deferred.await, { discard: true })
        yield* sourceRelease
      }),
    reconcile: () =>
      Effect.forEach(
        current().unresolved,
        (input) =>
          deps.conversation.receipt(input.id).pipe(
            Effect.flatMap((receipt) =>
              receipt === null ? Effect.void : post({ kind: "Accepted", id: input.id, receipt })
            ),
            Effect.ignore
          ),
        { discard: true }
      )
  }
}
