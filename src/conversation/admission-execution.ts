import { Effect, Queue } from "effect"
import type { Command } from "./admission-core/generated/core.mjs"
import type { Message } from "./contracts.ts"
import type { Responses } from "./response-runtime.ts"

/** Holds the response lane while the mailbox chooses the next obligation; the mailbox never waits for this lane. */
export const executeAdmissionStart = Effect.fn("Conversation.executeAdmissionStart")(function* (
  commands: Queue.Queue<Command>,
  receipt: Message,
  replies: Responses,
  authorized: () => boolean,
  authorize: Effect.Effect<void>
) {
  const command = yield* Queue.take(commands)
  if (command.$ === "RequestStart") {
    yield* authorize
    const authorizedCommand = yield* Queue.take(commands)
    if (authorizedCommand.$ === "StartResponse") yield* replies.start(receipt, false, authorized)
    if (authorizedCommand.$ === "RecordSuperseded") yield* replies.recordSuperseded(receipt)
    return
  }
  if (command.$ === "RecordSuperseded") yield* replies.recordSuperseded(receipt)
})
