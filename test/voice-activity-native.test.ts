import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { SpeechActivity, sileroSpeechActivityLayer } from "../src/voice/index.ts"
const suppliedModel = process.env.BALABOL_TEST_ACTIVITY_MODEL
it.skipIf(suppliedModel === undefined)(
  "runs the pinned CPU model on supplied silence through the real scoped adapter",
  async () => {
    if (suppliedModel === undefined) throw new Error("Missing qualification model path")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const activity = yield* (yield* SpeechActivity).open()
          let classified = 0
          for (let index = 0; index < 50; index++) {
            const windows = yield* activity.push({
              sampleRate: 16000,
              channels: 1,
              samplesPerChannel: 320,
              data: new Int16Array(320)
            })
            classified += windows.length
            expect(windows.every((window) => !window.speech)).toBe(true)
          }
          expect(classified).toBe(31)
        })
      ).pipe(Effect.provide(sileroSpeechActivityLayer({ modelPath: suppliedModel })))
    )
  }
)
it("rejects missing or wrong pinned model bytes before acquiring a runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-activity-test-"))
  try {
    const file = join(directory, "wrong.onnx")
    await writeFile(file, "Not a model")
    for (const modelPath of [file, join(directory, "missing.onnx")]) {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* SpeechActivity
          })
        ).pipe(Effect.provide(sileroSpeechActivityLayer({ modelPath })), Effect.result)
      )
      expect(result._tag).toBe("Failure")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
