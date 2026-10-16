import { Effect, Stream } from "effect"
import { expect, it } from "vitest"
import type { AnswerRequest } from "../src/answer-generation/index.ts"
import { AnswerGeneration, fakeAnswerLayer } from "../src/answer-generation/index.ts"
const request = {
  inputDeliveryId: "11111111-1111-4111-8111-111111111111",
  responseId: "22222222-2222-4222-8222-222222222222",
  model: "sol",
  prior: "<chat>\n</chat>",
  input: "Fixture input",
  inputLanguageSpans: [],
  responseLanguage: "en",
  capabilities: ["memory.context"]
} satisfies AnswerRequest
for (const [language, text] of [
  ["ru", "Это демонстрационный ответ."],
  ["fr", "Ceci est une réponse fictive."],
  ["en", "This is a fixture reply."],
  ["ja", "これはデモの返答です。"]
])
  it(`emits localized ${language} fixture text with valid relative annotations`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* AnswerGeneration
        const events = yield* Stream.runCollect(provider.generate({ ...request, responseLanguage: language ?? "en" }))
        const deltas = events.filter((event) => event.kind === "Delta")
        expect(deltas.map((event) => event.text).join("")).toBe(text)
        for (const event of deltas)
          expect(event.languageSpans).toEqual([{ language, start: 0, end: event.text.length }])
        expect(events.at(-1)).toEqual({ kind: "Completed" })
      }).pipe(Effect.provide(fakeAnswerLayer(0)))
    )
  })
it("rejects a valid extra tag through fake capabilities rather than the language domain", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* AnswerGeneration
      return yield* Stream.runCollect(provider.generate({ ...request, responseLanguage: "de" }))
    }).pipe(Effect.provide(fakeAnswerLayer(0)), Effect.result)
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.message).toBe("Unsupported answer language")
})
