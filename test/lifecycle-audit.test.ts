import { Cause, Effect, Exit, Layer } from "effect"
import { expect, it } from "vitest"
import { Memory, StorageUnavailable, type Receipt } from "../src/memory/index.ts"
import { appendReply } from "../src/conversation/reply-persistence.ts"
import { auditIdentity, OperationAudit, operationAuditLayer, withAuditSpan } from "../src/operation-audit/index.ts"
import { SpeechActivity, sileroSpeechActivityLayer, type VoiceFrame } from "../src/voice/index.ts"
import { closeLiveKitAudio } from "../src/voice/livekit-output.ts"
const deliveryId = "11111111-1111-4111-8111-111111111111"
const inputDeliveryId = "22222222-2222-4222-8222-222222222222"
const receipt: Receipt = {
  deliveryId,
  inputDeliveryId,
  responseId: deliveryId,
  role: "assistant",
  outcome: "completed",
  text: "private transcript",
  languageSpans: [],
  recordId: 1,
  position: 1
}
const memory = (find: Memory["Service"]["find"]): Memory["Service"] => ({
  find,
  append: () => Effect.fail(new StorageUnavailable({ message: "private storage details" })),
  retryFailed: () => Effect.succeed(0),
  latestInput: () => Effect.succeed(undefined),
  pendingReply: () => Effect.succeed(undefined),
  findReply: () => Effect.succeed(undefined),
  snapshot: () => Effect.succeed({ state: "ready", text: "" }),
  page: () => Effect.succeed([]),
  olderPage: () => Effect.succeed([])
})
it("exports the failed append even when receipt verification recovers it", async () => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Memory
      expect(yield* appendReply(store, receipt)).toEqual(receipt)
      yield* (yield* OperationAudit).flush
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            Memory,
            memory(() => Effect.succeed({ state: "Accepted", receipt }))
          ),
          operationAuditLayer({
            write: async (line) => {
              lines.push(line)
            }
          })
        )
      )
    )
  )
  expect(lines.map((line): unknown => JSON.parse(line))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "conversation.append",
        outcome: "Failed",
        response: auditIdentity(deliveryId),
        input: auditIdentity(inputDeliveryId)
      }),
      expect.objectContaining({
        name: "conversation.verify",
        outcome: "Succeeded",
        response: auditIdentity(deliveryId),
        input: auditIdentity(inputDeliveryId)
      })
    ])
  )
  expect(lines.join("")).not.toContain("private")
  expect(lines.join("")).not.toContain(deliveryId)
  expect(lines.join("")).not.toContain(inputDeliveryId)
})
it("exports verification defects and interruptions before callers recover them", async () => {
  for (const [failure, outcome] of [
    [Effect.die("private defect"), "Defect"],
    [Effect.interrupt, "Cancelled"]
  ] as const) {
    const lines: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Memory
        yield* appendReply(store, receipt).pipe(Effect.exit)
        yield* (yield* OperationAudit).flush
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              Memory,
              memory(() => failure)
            ),
            operationAuditLayer({
              write: async (line) => {
                lines.push(line)
              }
            })
          )
        )
      )
    )
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "conversation.verify", outcome })])
    )
    expect(lines.join("")).not.toContain("private")
  }
})
it("preserves Silero inference failure instead of overwriting it as invalid output", async () => {
  const lines: string[] = []
  const layer = sileroSpeechActivityLayer(
    { modelPath: "fixture.onnx" },
    {
      open: () =>
        Effect.succeed({
          run: async () => {
            throw new Error("private native error")
          }
        })
    }
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* (yield* SpeechActivity).open()
        const frame: VoiceFrame = { sampleRate: 16000, channels: 1, samplesPerChannel: 320, data: new Int16Array(320) }
        yield* stream.push(frame)
        const error = yield* stream.push(frame).pipe(withAuditSpan("voice.activity"), Effect.flip)
        expect(error.diagnostic).toEqual({ category: "Media", provider: "silero", reason: "ProviderFailure" })
        yield* (yield* OperationAudit).flush
      })
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          operationAuditLayer({
            write: async (line) => {
              lines.push(line)
            }
          })
        )
      )
    )
  )
  expect(lines.map((line): unknown => JSON.parse(line))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "voice.activity",
        outcome: "Failed",
        diagnostic: { category: "Media", reason: "ProviderFailure", provider: "silero" }
      })
    ])
  )
  expect(lines.join("")).not.toContain("private")
})
it("releases the native source when track close fails", async () => {
  let released = false
  const exit = await Effect.runPromise(
    closeLiveKitAudio(
      {
        close: async () => {
          throw new Error("private track close")
        }
      },
      {
        closed: false,
        close: async () => {
          released = true
        }
      }
    ).pipe(Effect.exit)
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(released).toBe(true)
})
it("exports both native release failures instead of overwriting the track failure", async () => {
  const lines: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* closeLiveKitAudio(
        {
          close: async () => {
            throw new Error("private track close")
          }
        },
        {
          closed: false,
          close: async () => {
            throw new Error("private source close")
          }
        }
      ).pipe(withAuditSpan("voice.release"), Effect.exit)
      if (Exit.isSuccess(exit)) throw new Error("Expected both cleanup operations to fail")
      expect(exit.cause.reasons.filter(Cause.isFailReason)).toHaveLength(2)
      yield* (yield* OperationAudit).flush
    }).pipe(
      Effect.provide(
        operationAuditLayer({
          write: async (line) => {
            lines.push(line)
          }
        })
      )
    )
  )
  expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
    expect.objectContaining({
      name: "voice.release",
      outcome: "Failed",
      failures: [
        expect.objectContaining({
          kind: "Fail",
          diagnostic: { category: "Media", provider: "livekit", reason: "TrackRelease" }
        }),
        expect.objectContaining({
          kind: "Fail",
          diagnostic: { category: "Media", provider: "livekit", reason: "SourceRelease" }
        })
      ]
    })
  ])
  expect(lines.join("")).not.toContain("private")
})
