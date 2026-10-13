import { fork } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation, SendMessage } from "../src/conversation/index.ts"
import { conversationLayer } from "../src/bootstrap/index.ts"
import { SqliteStorage } from "../src/memory/sqlite.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("SIGKILL after raw commit releases process writer lease and retry recovers without append", async () => {
  const fixture = await temporaryDatabase()
  const child = fork(fileURLToPath(new URL("./crash-child.ts", import.meta.url)), [fixture.path], {
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  })
  try {
    const [message] = await once(child, "message")
    expect(message).toBe("raw-committed")
    expect(() => new SqliteStorage(fixture.path)).toThrow()
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const payload = Schema.decodeUnknownSync(SendMessage)({
            deliveryId: "11111111-1111-4111-8111-111111111111",
            text: "crash window"
          })
          expect((yield* conversation.send(payload)).recordId).toBe(0)
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    child.kill("SIGKILL")
    await fixture.close()
  }
})
