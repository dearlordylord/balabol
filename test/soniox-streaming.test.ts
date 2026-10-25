import { it } from "@effect/vitest"
import { type Cause, Deferred, Effect, Fiber, Queue, Redacted, Stream } from "effect"
import { expect } from "vitest"
import {
  RecognitionFailed,
  SpeechRecognition,
  sonioxRecognitionLayer,
  type RecognitionAudio
} from "../src/speech-recognition/index.ts"
import { SonioxSocket } from "./soniox-fixture.ts"
const request = { utteranceId: "11111111-1111-4111-8111-111111111111", allowedLanguages: ["fr"] }
const frame: RecognitionAudio = {
  encoding: "pcm-s16le",
  sampleRateHz: 16000,
  channels: 1,
  sampleFrames: 512,
  bytes: new Uint8Array(1024)
}
const collect = (socket: SonioxSocket, audio: Stream.Stream<RecognitionAudio, RecognitionFailed>) =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    if (provider.recognizeStreaming === undefined) throw new Error("Missing streaming recognition")
    return yield* Stream.runCollect(provider.recognizeStreaming(request, audio))
  }).pipe(
    Effect.provide(
      sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory)
    )
  )
it.effect("waits for connection then sends every queued frame in order before closing input", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket([], "connecting")
    const second = { ...frame, bytes: new Uint8Array(1024).fill(1) }
    const fiber = yield* collect(socket, Stream.make(frame, second)).pipe(Effect.forkChild)
    yield* Deferred.await(socket.created)
    expect(socket.sent).toEqual([])
    for (let attempt = 0; socket.onopen === null && attempt < 10; attempt++) yield* Effect.yieldNow
    expect(socket.onopen).not.toBeNull()
    socket.onopen?.call(socket, new Event("open"))
    yield* Fiber.join(fiber)
    expect(socket.sent.slice(1)).toEqual([frame.bytes, second.bytes, ""])
    expect(socket.closed).toBe(true)
  })
)
it.effect("cancels open input without graceful completion and fences captured callbacks", () =>
  Effect.gen(function* () {
    const audio = yield* Queue.make<RecognitionAudio, RecognitionFailed | Cause.Done>({ capacity: 2 })
    const socket = new SonioxSocket([], "wait")
    const fiber = yield* collect(socket, Stream.fromQueue(audio)).pipe(Effect.forkChild)
    yield* Deferred.await(socket.opened)
    const late = socket.onmessage
    yield* Fiber.interrupt(fiber)
    Queue.offerUnsafe(audio, frame)
    late?.call(socket, new MessageEvent("message", { data: JSON.stringify({ finished: true }) }))
    expect(socket.sent).not.toContain("")
    expect(socket.closed).toBe(true)
  })
)
it.effect("rejects provider completion while microphone input is still open", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket([], "wait")
    const fiber = yield* collect(socket, Stream.never).pipe(Effect.result, Effect.forkChild)
    yield* Deferred.await(socket.opened)
    socket.message({ finished: true })
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { diagnostic: { reason: "Incomplete" } }
    })
    expect(socket.closed).toBe(true)
  })
)
it.effect("reports upstream audio failure without finalizing a partial transcript", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket()
    const result = yield* collect(
      socket,
      Stream.concat(Stream.make(frame), Stream.fail(new RecognitionFailed({ message: "Missing audio" })))
    ).pipe(Effect.result)
    expect(result).toMatchObject({ _tag: "Failure", failure: { message: "Missing audio" } })
    expect(socket.sent).not.toContain("")
    expect(socket.closed).toBe(true)
  })
)
it.effect("bounds platform socket buffering instead of silently accumulating audio", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket()
    socket.bufferedAmount = 524288
    const result = yield* collect(socket, Stream.make(frame)).pipe(Effect.result)
    expect(result).toMatchObject({ _tag: "Failure", failure: { diagnostic: { reason: "Limit" } } })
    expect(socket.sent).toHaveLength(1)
    expect(socket.closed).toBe(true)
  })
)
it.effect("validates streaming PCM and bounds the aggregate audio request", () =>
  Effect.gen(function* () {
    for (const audio of [
      Stream.make({ ...frame, bytes: new Uint8Array(2) }),
      Stream.make({ ...frame, sampleFrames: 240000, bytes: new Uint8Array(480000) }, frame)
    ]) {
      const socket = new SonioxSocket()
      expect(yield* collect(socket, audio).pipe(Effect.isFailure)).toBe(true)
      expect(socket.sent).not.toContain("")
      expect(socket.closed).toBe(true)
    }
  })
)
