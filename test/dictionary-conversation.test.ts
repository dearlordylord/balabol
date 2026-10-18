import { buildDictionaryCatalog } from "../src/dictionary/provision.ts"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { DictionaryPage, sqliteDictionaryLayer } from "../src/dictionary/index.ts"
import { PersonalKnowledge, sqliteKnowledgeLayer } from "../src/personal-knowledge/index.ts"
import { SqliteMemoryStorage } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"

it("looks up sourced etymology through the conversation without changing personal knowledge", async () => {
  const database = await temporaryDatabase()
  const catalog = join(database.directory, "dictionary.sqlite")
  await buildDictionaryCatalog({
    destination: catalog,
    languages: ["fr"],
    metadata: {
      name: "English Wiktionary via Wiktextract",
      url: "https://en.wiktionary.org/wiki/avocat",
      version: "fixture",
      license: "CC BY-SA 4.0"
    },
    source: (async function* () {
      yield JSON.stringify({
        word: "avocat",
        lang_code: "fr",
        pos: "noun",
        senses: [{ glosses: ["lawyer"] }],
        etymology_text: "From Latin advocatus."
      })
    })()
  })
  let calls = 0
  const provider = knowledgeAnswerLayer(
    async (request) => {
      calls++
      expect(request.instructions).toContain("Separate sourced linguistic relationships from invented mnemonics")
      expect(request.instructions).toContain(
        "Always call lookup_dictionary before creating etymologies or vocabulary associations"
      )
      expect(request.instructions).toContain("without waiting for an explicit user request")
      expect(request.instructions).toContain("never claim attested ancestry without source evidence")
      expect(request.instructions).not.toContain("credit Wiktionary contributors")
      expect(request.instructions).not.toContain("THIRD_PARTY_NOTICES.md")
      if (calls === 1) return tool("lookup_dictionary", { language: "fr", word: "avocat" }, "dictionary-1")
      const result = Schema.decodeUnknownSync(DictionaryPage)(lastToolResult(request))
      expect(result.entries[0]?.etymologyText).toBe("From Latin advocatus.")
      expect(result.entries[0]?.senses[0]?.glosses).toEqual(["lawyer"])
      expect(result.source.version).toBe("fixture")
      return answer("The lawyer sense comes from Latin advocatus.")
    },
    undefined,
    sqliteDictionaryLayer(catalog)
  )
  const knowledge = Layer.unwrap(
    Effect.gen(function* () {
      const resource = yield* SqliteMemoryStorage
      return sqliteKnowledgeLayer(resource.storage.database)
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "What is the etymology of avocat?" }
          yield* conversation.send(input)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe("The lawyer sense comes from Latin advocatus.")
          const personal = yield* PersonalKnowledge
          expect((yield* personal.inspect()).revision).toBe(0)
          expect((yield* conversation.page({ limit: 20 })).messages).toHaveLength(2)
        })
      ).pipe(
        Effect.provide(
          knowledge.pipe(
            Layer.provideMerge(
              replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
            )
          )
        )
      )
    )
    expect(calls).toBe(2)
  } finally {
    await database.close()
  }
})

it("returns dictionary unavailability to the model and still completes the answer", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const provider = knowledgeAnswerLayer(
    async (request) => {
      calls++
      if (calls === 1) return tool("lookup_dictionary", { language: "fr", word: "avocat" }, "dictionary-missing")
      expect(lastToolResult(request)).toMatchObject({ _tag: "DictionaryUnavailable", reason: "Missing" })
      return answer("The local dictionary is unavailable; I cannot verify that etymology.")
    },
    undefined,
    sqliteDictionaryLayer(join(database.directory, "missing.sqlite"))
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Check avocat." }
          yield* conversation.send(input)
          expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Completed")
          expect((yield* conversation.page({ limit: 20 })).messages).toHaveLength(2)
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
        )
      )
    )
    expect(calls).toBe(2)
  } finally {
    await database.close()
  }
})
