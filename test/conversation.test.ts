import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Conversation, SendMessage } from "../src/conversation/index.ts"

import { conversationLayer } from "../src/bootstrap/index.ts"

const deliveryId = "11111111-1111-4111-8111-111111111111"
const input = Schema.decodeUnknownSync(SendMessage)({ deliveryId, text: "bonjour" })
const run = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const conversation = yield* Conversation
      const first = yield* conversation.send(input)
      const duplicate = yield* conversation.send(input)
      expect(duplicate).toEqual(first)
      expect((yield* conversation.page({ limit: 1 })).messages).toEqual([first])
      const conflict = yield* Effect.flip(conversation.send({ ...input, text: "different" }))
      expect(conflict._tag).toBe("DeliveryConflict")
    })
  ).pipe(Effect.provide(conversationLayer(path)))

describe("the single durable conversation", () => {
  it("accepts once, detects conflicts and retains the receipt across reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "balabol-conversation-"))
    try {
      await Effect.runPromise(run(join(directory, "memory.sqlite")))
      await Effect.runPromise(run(join(directory, "memory.sqlite")))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
