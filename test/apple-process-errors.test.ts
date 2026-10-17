import { Effect } from "effect"
import { expect, it } from "vitest"
import { runAppleProcess } from "../src/speech-synthesis/apple-process.ts"
it("preserves a structured native reason without publishing private process output", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      runAppleProcess(process.execPath, [
        "-e",
        'process.stdout.write(JSON.stringify({reason:"UnsupportedLanguage",text:"private transcript"}));process.exit(1)'
      ])
    )
  )
  expect(error.reason).toBe("UnsupportedLanguage")
  expect(error.message).toContain("without a configured voice")
  expect(error.message).not.toContain("private")
})
it("replaces unstructured native output with a safe explicit process failure", async () => {
  const error = await Effect.runPromise(
    Effect.flip(runAppleProcess(process.execPath, ["-e", 'process.stdout.write("private transcript");process.exit(1)']))
  )
  expect(error.reason).toBe("NativeProcessFailed")
  expect(error.message).toBe("Local synthesis process failed")
})
