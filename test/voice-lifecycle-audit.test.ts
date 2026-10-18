import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { OperationAudit, operationAuditLayer, auditIdentity } from "../src/operation-audit/index.ts"
import { Voice, VoiceTransport, VoiceFailed, VoiceDiagnostics, voiceDiagnosticsLayer } from "../src/voice/index.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer } from "./voice-output-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
it("persists recovered datagram failures and scoped output ownership without changing mute or End", async () => {
  const lines: string[] = []
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const layer = Layer.effect(
    VoiceTransport,
    Effect.gen(function* () {
      const real = yield* VoiceTransport
      return VoiceTransport.of({
        open: (...args) =>
          real
            .open(...args)
            .pipe(
              Effect.map((opened) => ({
                ...opened,
                connection: {
                  ...opened.connection,
                  publish: () =>
                    Effect.fail(new VoiceFailed({ code: "AudioUnavailable", message: "private media token" }))
                }
              }))
            )
      })
    })
  ).pipe(Layer.provide(transport.layer))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const join = yield* voice.start(startVoiceRequest())
          expect((yield* voice.mute(join.sessionId, true)).muted).toBe(true)
          yield* voice.end(join.sessionId)
          yield* (yield* OperationAudit).flush
        })
      ).pipe(
        Effect.provide(
          voiceOutputLayer(database.path, { ...transport, layer }).pipe(
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
    const records: { name: string; outcome: string; session?: string }[] = lines.map((line) => JSON.parse(line))
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "voice.publish", outcome: "Failed" }),
        expect.objectContaining({ name: "voice.registration", outcome: "Succeeded" }),
        expect.objectContaining({ name: "voice.release", outcome: "Succeeded" })
      ])
    )
    expect(records.find((record) => record.name === "voice.publish")?.session).toMatch(/^[a-f0-9]{32}$/)
    expect(records.some((record) => record.session === auditIdentity(""))).toBe(false)
    expect(lines.join("")).not.toContain("private")
  } finally {
    await database.close()
  }
})

it("reports journal write failure once without revealing the storage error or breaking capture", async () => {
  let warnings = 0
  let writes = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* VoiceDiagnostics
      sink.record({ cause: "backendSpeech", sessionId: "11111111-1111-4111-8111-111111111111", applied: true })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      sink.record({ cause: "backendSpeech", sessionId: "11111111-1111-4111-8111-111111111111", applied: true })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(writes).toBe(2)
      expect(warnings).toBe(1)
    }).pipe(
      Effect.provide(
        voiceDiagnosticsLayer(
          {
            write: async () => {
              writes += 1
              throw new Error("private storage path")
            }
          },
          () => {
            warnings += 1
          }
        )
      )
    )
  )
})
