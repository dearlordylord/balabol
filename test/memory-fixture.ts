import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Storage } from "@firfi/unii"
import { Effect, Layer } from "effect"
import type { AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { DurableMemory, sqliteStorageLayer, durableMemoryLayer, uniiLayer } from "../src/memory/index.ts"

export const temporaryDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-memory-"))
  return {
    path: join(directory, "memory.sqlite"),
    directory,
    close: () => rm(directory, { recursive: true, force: true })
  }
}
export const decoratedConversation = (
  path: string,
  decorate: (storage: Storage) => Storage,
  answer?: Layer.Layer<AnswerGeneration>
) => {
  const resource = sqliteStorageLayer(path)
  const conversation =
    answer === undefined
      ? Conversation.layer
      : Conversation.configuredLayer.pipe(
          Layer.provide(Layer.merge(answer, Layer.succeed(ReplyConfiguration, defaultReplySettings)))
        )
  return conversation
    .pipe(
      Layer.provide(
        uniiLayer.pipe(
          Layer.provide(
            Layer.effect(
              DurableMemory,
              Effect.gen(function* () {
                const adapter = yield* DurableMemory
                return { ...adapter, storage: decorate(adapter.storage) }
              })
            ).pipe(Layer.provide(durableMemoryLayer.pipe(Layer.provide(resource))))
          )
        )
      )
    )
    .pipe(Layer.provideMerge(resource))
}
