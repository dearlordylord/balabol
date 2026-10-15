import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { runAppleProcess } from "../src/speech-synthesis/apple-process.ts"

it.live.skipIf(process.platform !== "darwin")(
  "native render planner conserves text and chooses only configured installed locale capabilities",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "balabol-render-plan-test-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      )
      const executable = join(directory, "planner-fixtures")
      yield* runAppleProcess("/usr/bin/xcrun", [
        "swiftc",
        "-parse-as-library",
        "-swift-version",
        "6",
        "-strict-concurrency=complete",
        "-warnings-as-errors",
        "src/speech-synthesis/apple-render-plan.swift",
        "test/apple-render-plan.test.swift",
        "-o",
        executable
      ])
      expect(yield* runAppleProcess(executable, [])).toContain("Apple render planner fixtures passed")
    }).pipe(Effect.scoped)
)
