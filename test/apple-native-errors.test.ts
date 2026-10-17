import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { appleNative } from "../src/speech-synthesis/apple-native.ts"
import type { AppleSynthesisSettings } from "../src/speech-synthesis/apple-native.ts"
const voice = { id: "fixture", actualLocale: "ru-RU" }
for (const operation of ["plan", "render"] as const)
  for (const structured of [true, false])
    it(`preserves the native ${operation} failure category (structured=${structured})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "balabol-native-error-"))
      const helper = join(directory, "speech")
      const reason = operation === "plan" ? "UnsupportedLanguage" : "SynthesisWriteFailed"
      const output = structured ? JSON.stringify({ reason }) : "private process output"
      await writeFile(helper, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});process.exit(1)\n`)
      await chmod(helper, 0o700)
      const settings: AppleSynthesisSettings = { provider: "apple", helperExecutable: helper, ffmpegExecutable: helper }
      try {
        const work =
          operation === "plan"
            ? appleNative.plan(settings, "Fixture", voice, [voice]).pipe(Effect.asVoid)
            : appleNative.render(settings, "Fixture", voice).pipe(Effect.asVoid)
        const error = await Effect.runPromise(Effect.flip(Effect.scoped(work)))
        expect(error.reason).toBe(
          structured ? reason : operation === "plan" ? "SynthesisPlanFailed" : "SynthesisRenderFailed"
        )
        expect(error.message).not.toContain("private")
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
