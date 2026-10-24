import { Effect, Redacted, Stream, Layer } from "effect"
import { expect, it } from "vitest"
import { OperationAudit, operationAuditLayer, withAuditSpan } from "../src/operation-audit/index.ts"
import { SpeechRecognition, sonioxRecognitionLayer } from "../src/speech-recognition/index.ts"
import { SpeechSynthesis, sonioxSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { SonioxSocket } from "./soniox-fixture.ts"
import { SonioxSynthesisSocket } from "./soniox-synthesis-fixture.ts"
const key = Redacted.make("fixture-only")
const identity = "11111111-1111-4111-8111-111111111111"
const persisted = async <A, E, R>(work: Effect.Effect<A, E, R>, layer: Layer.Layer<R, unknown>) => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* OperationAudit
      yield* work.pipe(Effect.exit)
      yield* audit.flush
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(
            operationAuditLayer({
              write: async (line) => {
                lines.push(line)
              }
            })
          )
        )
      )
    )
  )
  return lines
}
it.each([
  [401, "Authentication"],
  [403, "Authentication"],
  [500, "Provider"],
  [402, "Billing"],
  [429, "Quota"]
] as const)("persists recognition HTTP %d as %s without provider payload", async (status, reason) => {
  const socket = new SonioxSocket([{ error_code: status, error_type: "private provider payload" }])
  const work = Effect.gen(function* () {
    const recognition = yield* SpeechRecognition
    return yield* Stream.runDrain(
      recognition.recognize({
        utteranceId: identity,
        allowedLanguages: ["fr"],
        audio: { encoding: "pcm-s16le", sampleRateHz: 16000, channels: 1, sampleFrames: 2, bytes: new Uint8Array(4) }
      })
    )
  }).pipe(withAuditSpan("voice.recognition"))
  const lines = await persisted(work, sonioxRecognitionLayer({ provider: "soniox", apiKey: key }, socket.factory))
  expect(lines.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      name: "voice.recognition",
      outcome: "Failed",
      diagnostic: { category: "Recognition", provider: "soniox", reason, status }
    })
  )
  expect(lines.join("")).not.toContain("private provider payload")
})
it("persists synthesis billing failure without provider payload", async () => {
  const socket = new SonioxSynthesisSocket([{ error_code: 402, error_message: "private provider payload" }])
  const work = Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    return yield* Stream.runDrain(
      synthesis.synthesize({ responseId: identity, phraseId: identity, text: "Private source", language: "fr" })
    )
  }).pipe(withAuditSpan("voice.synthesis"))
  const lines = await persisted(
    work,
    sonioxSynthesisLayer({ provider: "soniox", apiKey: key, voice: "Adrian" }, socket.factory)
  )
  expect(lines.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      name: "voice.synthesis",
      outcome: "Failed",
      diagnostic: { category: "Synthesis", provider: "soniox", reason: "Billing", status: 402 }
    })
  )
  expect(lines.join("")).not.toContain("private")
  expect(lines.join("")).not.toContain("Private source")
})
