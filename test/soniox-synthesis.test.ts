import { Deferred, Effect, Fiber, Redacted, Stream } from "effect"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { SpeechSynthesis, sonioxSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { SonioxSynthesisSocket } from "./soniox-synthesis-fixture.ts"
const phrase = {
  responseId: "11111111-1111-4111-8111-111111111111",
  phraseId: "22222222-2222-4222-8222-222222222222",
  text: "Bonjour мир hello",
  language: "fr"
}
const settings = { provider: "soniox" as const, apiKey: Redacted.make("fixture-not-a-key"), voice: "Adrian" }
const packet = (body: object) => ({ stream_id: phrase.phraseId, ...body })
const pcm = (frames = 2401) => Buffer.alloc(frames * 2).toString("base64")
const run = (socket: SonioxSynthesisSocket) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const synthesis = yield* SpeechSynthesis
      return yield* Stream.runCollect(synthesis.synthesize(phrase))
    }).pipe(Effect.provide(sonioxSynthesisLayer(settings, socket.factory)))
  )
it("streams bounded contiguous PCM and completes only after audio_end then terminated", async () => {
  const socket = new SonioxSynthesisSocket([packet({ audio: pcm(), audio_end: true }), packet({ terminated: true })])
  const events = await run(socket)
  expect(events.map((e) => e.kind)).toEqual(["Chunk", "Chunk", "Chunk", "Completed"])
  expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3])
  expect(events.flatMap((e) => (e.kind === "Chunk" ? [e.audio.sampleFrames] : []))).toEqual([1200, 1200, 1])
  expect(JSON.parse(String(socket.sent[0]))).toMatchObject({
    model: "tts-rt-v2",
    language: "fr",
    sample_rate: 24000,
    voice: "Adrian"
  })
  expect(JSON.parse(String(socket.sent[1]))).toMatchObject({ text: phrase.text, text_end: true })
  expect(socket.closed).toBe(true)
})
it.each([
  ["malformed JSON", "{"],
  ["wrong identity", { stream_id: "other", audio: pcm() }],
  ["invalid base64", packet({ audio: "%%%%" })],
  ["unaligned PCM", packet({ audio: Buffer.alloc(1).toString("base64") })],
  ["early terminal", packet({ terminated: true })],
  ["empty audio", packet({ audio_end: true })]
])("rejects %s without completion", async (_label, bad) => {
  const socket = new SonioxSynthesisSocket([bad, packet({ terminated: true })])
  await expect(run(socket)).rejects.toThrow()
  expect(socket.closed).toBe(true)
})
it.each([401, 402, 429, 500])("reports actionable sanitized provider failure %s", async (code) => {
  const socket = new SonioxSynthesisSocket([{ error_code: code, error_message: "PRIVATE RAW MESSAGE" }])
  await expect(run(socket)).rejects.toThrow(/Soniox/)
  await expect(
    run(new SonioxSynthesisSocket([{ error_code: code, error_message: "PRIVATE RAW MESSAGE" }]))
  ).rejects.not.toThrow("PRIVATE RAW MESSAGE")
})
it.each(["close", "error"] as const)("fails on premature %s", async (terminal) => {
  await expect(run(new SonioxSynthesisSocket([], terminal))).rejects.toThrow()
})
it.each(["wait", "connecting"] as const)("cancels %s socket and fences captured late callbacks", async (terminal) => {
  const socket = new SonioxSynthesisSocket([], terminal)
  await Effect.runPromise(
    Effect.gen(function* () {
      const synthesis = yield* SpeechSynthesis
      const fiber = yield* Stream.runCollect(synthesis.synthesize(phrase)).pipe(Effect.forkChild)
      yield* Deferred.await(socket.created)
      if (terminal === "wait") yield* Deferred.await(socket.opened)
      const late = socket.onmessage
      yield* Fiber.interrupt(fiber)
      late?.call(socket, new MessageEvent("message", { data: JSON.stringify(packet({ terminated: true })) }))
      expect(socket.closed).toBe(true)
      expect(socket.onmessage).toBeNull()
    }).pipe(Effect.provide(sonioxSynthesisLayer(settings, socket.factory)))
  )
})

it.effect("bounds a stalled synthesis with the Effect clock", () => {
  const socket = new SonioxSynthesisSocket([], "wait")
  return Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    const fiber = yield* Stream.runCollect(synthesis.synthesize(phrase)).pipe(Effect.result, Effect.forkChild)
    yield* Deferred.await(socket.opened)
    yield* TestClock.adjust(60001)
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { message: "Soniox synthesis deadline exceeded" }
    })
    expect(socket.closed).toBe(true)
  }).pipe(Effect.provide(sonioxSynthesisLayer(settings, socket.factory)))
})
it("joins odd-byte fragments and caps event count independently of provider packet count", async () => {
  const fragments = Array.from({ length: 2401 }, () => packet({ audio: Buffer.alloc(1).toString("base64") }))
  const socket = new SonioxSynthesisSocket([
    ...fragments,
    packet({ audio: Buffer.alloc(1).toString("base64"), audio_end: true }),
    packet({ terminated: true })
  ])
  const events = await run(socket)
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2])
  expect(events.flatMap((event) => (event.kind === "Chunk" ? [event.audio.sampleFrames] : []))).toEqual([1200, 1])
})
it("accepts the full sixty-second budget as at most1200 chunks", async () => {
  const events = await run(
    new SonioxSynthesisSocket([packet({ audio: pcm(1440000), audio_end: true }), packet({ terminated: true })])
  )
  expect(events).toHaveLength(1201)
  expect(events.at(-1)).toMatchObject({ kind: "Completed", sequence: 1200 })
})
it("rejects audio beyond the phrase duration budget", async () => {
  await expect(
    run(
      new SonioxSynthesisSocket([
        packet({ audio: pcm(1440000) }),
        packet({ audio: pcm(1), audio_end: true }),
        packet({ terminated: true })
      ])
    )
  ).rejects.toThrow(/limit/)
})
it("rejects audio following audio_end", async () => {
  await expect(
    run(
      new SonioxSynthesisSocket([
        packet({ audio: pcm(1), audio_end: true }),
        packet({ audio: pcm(1) }),
        packet({ terminated: true })
      ])
    )
  ).rejects.toThrow(/order/)
})
