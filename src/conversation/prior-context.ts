import { Effect } from "effect"
import type { Memory } from "../memory/index.ts"
import type { ReplySettings } from "./reply-configuration.ts"
const maximumPriorWaitMillis = 60000
/** Waiting belongs to the reply; canceling it never cancels independent memory compaction. */
export const waitForPriorMemory = (memory: Memory["Service"], before: number, settings: ReplySettings) =>
  Effect.gen(function* () {
    let snapshot = yield* memory.snapshot(before)
    for (let attempt = 0; snapshot.state === "pending" && attempt < settings.contextWaitAttempts; attempt++) {
      yield* Effect.sleep(settings.contextWaitMillis)
      snapshot = yield* memory.snapshot(before)
    }
    return snapshot
  }).pipe(
    Effect.timeoutOrElse({
      duration: Math.min(maximumPriorWaitMillis, settings.contextWaitAttempts * settings.contextWaitMillis),
      orElse: () => Effect.succeed({ state: "pending" as const, text: null })
    })
  )
