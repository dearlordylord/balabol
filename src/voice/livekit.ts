import { randomUUID } from "node:crypto"
import { AudioStream, Room, RoomEvent, TrackSource } from "@livekit/rtc-node"
import { AccessToken, TrackSource as GrantSource } from "livekit-server-sdk"
import { Effect, Layer, Redacted, Schema, Scope, Clock, Exit } from "effect"
import { openLiveKitOutput } from "./livekit-output.ts"
import { VoiceTransport, failed } from "./contracts.ts"
import type { ReplyDeliveryAuthorization } from "../conversation/index.ts"
import type { AudioFrame } from "@livekit/rtc-node"
import type { VoiceEvent, VoiceFailed } from "./contracts.ts"
const secretMinimum = 32
const datagramLimitBytes = 15360
const tokenLifetimeMillis = 120000
const disconnectMillis = 1000
const websocket = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      return ["ws:", "wss:"].includes(new URL(value).protocol)
    } catch {
      return false
    }
  })
)
export const LiveKitSettings = Schema.Struct({
  url: websocket,
  mediaUrl: websocket,
  apiKey: Schema.String.check(Schema.isMinLength(1)),
  apiSecret: Schema.Redacted(Schema.String.check(Schema.isMinLength(secretMinimum)))
})
export type LiveKitSettings = typeof LiveKitSettings.Type
const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => failed("TransportUnavailable", "LiveKit operation failed") })
const encodeEvent = (event: VoiceEvent): Effect.Effect<Uint8Array, VoiceFailed> => {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  return bytes.length <= datagramLimitBytes
    ? Effect.succeed(bytes)
    : Effect.fail(failed("EventTooLarge", "Use bounded HTTP snapshot for this event"))
}
export const liveKitLayer = (settings: LiveKitSettings) =>
  Layer.effect(
    VoiceTransport,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(LiveKitSettings)(settings).pipe(
        Effect.mapError(() => failed("InvalidConfiguration", "Invalid LiveKit configuration"))
      )
      const scope = yield* Effect.scope
      return VoiceTransport.of({
        open: (identity, frame, disconnected, connected) =>
          Effect.gen(function* () {
            const roomScope = yield* Scope.fork(scope)
            return yield* Effect.gen(function* () {
              const token = (participant: string, client: boolean) => {
                const access = new AccessToken(config.apiKey, Redacted.value(config.apiSecret), {
                  identity: participant,
                  ttl: 120
                })
                access.addGrant({
                  roomJoin: true,
                  room: identity.roomName,
                  canSubscribe: true,
                  canPublish: true,
                  canPublishData: !client,
                  canPublishSources: [GrantSource.MICROPHONE]
                })
                return io(() => access.toJwt())
              }
              const backendParticipantIdentity = randomUUID()
              const backendToken = yield* token(backendParticipantIdentity, false)
              const room = new Room()
              let closed = false
              let closingRoom = false
              let generation = 0
              let trackSid: string | undefined
              let reader: ReadableStreamDefaultReader<AudioFrame> | undefined
              const stopTrack = () => {
                generation += 1
                void reader?.cancel().catch(() => undefined)
                reader = undefined
              }
              const disconnect = Effect.gen(function* () {
                if (closed) return
                closed = true
                stopTrack()
                yield* io(() => room.disconnect()).pipe(Effect.timeout(disconnectMillis), Effect.ignore)
              })
              yield* Scope.addFinalizer(roomScope, disconnect)
              const close = Effect.sync(() => {
                closingRoom = true
              }).pipe(Effect.andThen(Scope.close(roomScope, Exit.void)))
              room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                if (
                  closed ||
                  participant.identity !== identity.participantIdentity ||
                  publication.source !== TrackSource.SOURCE_MICROPHONE
                )
                  return
                stopTrack()
                trackSid = publication.sid
                const current = generation
                const stream = new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 })
                const selected = stream.getReader()
                reader = selected
                const drain = async () => {
                  try {
                    while (current === generation) {
                      const next = await selected.read()
                      if (next.done) return
                      if (current === generation) frame(publication.sid ?? "", next.value)
                    }
                  } catch {
                    if (current === generation) disconnected()
                  } finally {
                    await selected.cancel().catch(() => undefined)
                    selected.releaseLock()
                  }
                }
                void drain()
              })
              room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
                if (participant.identity === identity.participantIdentity && publication.sid === trackSid) stopTrack()
              })
              room.on(RoomEvent.ParticipantConnected, (participant) => {
                if (!closed && participant.identity === identity.participantIdentity) connected()
              })
              room.on(RoomEvent.ParticipantDisconnected, (participant) => {
                if (participant.identity === identity.participantIdentity) disconnected()
              })
              room.on(RoomEvent.Disconnected, () => {
                if (!closed) disconnected()
              })
              yield* io(() => room.connect(config.url, backendToken, { autoSubscribe: true, dynacast: false })).pipe(
                Effect.uninterruptible
              )
              const clientToken = yield* token(identity.participantIdentity, true)
              const now = yield* Clock.currentTimeMillis
              const local = room.localParticipant
              if (local === undefined) return yield* failed("TransportUnavailable", "Backend participant unavailable")
              return {
                join: {
                  ...identity,
                  backendParticipantIdentity,
                  mediaUrl: config.mediaUrl,
                  token: clientToken,
                  expiresAt: now + tokenLifetimeMillis
                },
                connection: {
                  openOutput: (outputEpoch: string, authorization: ReplyDeliveryAuthorization) =>
                    closed || closingRoom
                      ? Effect.fail(failed("AudioUnavailable", "The media connection is closed"))
                      : openLiveKitOutput(
                          local,
                          roomScope,
                          backendParticipantIdentity,
                          outputEpoch,
                          authorization,
                          () => Effect.sync(disconnected).pipe(Effect.andThen(disconnect))
                        ),
                  close: () => close,
                  publish: (event: VoiceEvent) =>
                    encodeEvent(event).pipe(
                      Effect.flatMap((bytes) =>
                        io(() =>
                          local.publishData(bytes, {
                            reliable: true,
                            destination_identities: [identity.participantIdentity],
                            topic: "balabol.voice"
                          })
                        )
                      )
                    )
                }
              }
            }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(roomScope, exit) : Effect.void)))
          })
      })
    })
  )
