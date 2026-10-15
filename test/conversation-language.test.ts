import { randomUUID } from "node:crypto"
import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { AnswerFailed, AnswerGeneration, type AnswerRequest, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("normalizes annotations, chooses greatest UTF16 coverage, and preserves receipts on restart", async () => {
  const fixture = await temporaryDatabase()
  const input = {
    deliveryId: randomUUID(),
    text: "Привет bonjour hi",
    languageSpans: [
      { language: "RU", start: 0, end: 6 },
      { language: "fr", start: 7, end: 14 },
      { language: "en", start: 15, end: 17 }
    ]
  }
  try {
    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const receipt = yield* conversation.send(input)
          expect(receipt.languageSpans[0]?.language).toBe("ru")
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.languageSpans?.every((span) => span.language === "fr")).toBe(true)
          expect(reply.receipt?.languageSpans).toEqual(reply.languageSpans)
          const duplicate = yield* conversation.send({ ...input, languageSpans: receipt.languageSpans })
          expect(duplicate).toEqual(receipt)
          const conflict = yield* Effect.flip(conversation.send({ ...input, languageSpans: [] }))
          expect(conflict._tag).toBe("DeliveryConflict")
          return yield* conversation.currentTurn()
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer())))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const restored = yield* conversation.currentTurn()
          expect(restored?.input).toEqual(first?.input)
          expect(restored?.reply.receipt).toEqual(first?.reply.receipt)
          expect(restored?.reply.languageSpans).toEqual(first?.reply.languageSpans)
          const page = yield* conversation.page({ limit: 100 })
          expect(page.messages.map((message) => message.languageSpans)).toEqual([
            first?.input.languageSpans,
            first?.reply.languageSpans
          ])
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer())))
    )
  } finally {
    await fixture.close()
  }
})

it("rejects unordered, overlapping, out-of-bounds and split-scalar input before acceptance", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          for (const languageSpans of [
            [{ language: "en", start: 0, end: 1 }],
            [{ language: "en", start: 0, end: 5 }],
            [
              { language: "en", start: 2, end: 4 },
              { language: "fr", start: 0, end: 2 }
            ],
            [
              { language: "en", start: 0, end: 3 },
              { language: "fr", start: 2, end: 4 }
            ]
          ]) {
            const error = yield* Effect.flip(
              conversation.send({ deliveryId: randomUUID(), text: "😀hi", languageSpans })
            )
            expect(error._tag).toBe("InvalidInput")
          }
          const receipt = yield* conversation.send({ deliveryId: randomUUID(), text: "😀hi" })
          expect(receipt.languageSpans).toEqual([])
          expect((yield* conversation.page({ limit: 100 })).messages[0]).toEqual(receipt)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer())))
    )
  } finally {
    await fixture.close()
  }
})

it("passes exact original annotations and chooses aggregate coverage, last-span ties and English fallback", async () => {
  const fixture = await temporaryDatabase()
  const requests: AnswerRequest[] = []
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: (request) => {
      requests.push(request)
      return Stream.make(
        { kind: "Delta", text: "😀", languageSpans: [{ language: request.responseLanguage, start: 0, end: 2 }] },
        { kind: "Delta", text: "ok", languageSpans: [{ language: request.responseLanguage, start: 0, end: 2 }] },
        { kind: "Completed" }
      )
    }
  })
  const annotations = [
    [
      { language: "ru", start: 0, end: 3 },
      { language: "fr", start: 3, end: 7 },
      { language: "ru", start: 7, end: 10 }
    ],
    [
      { language: "ru", start: 0, end: 5 },
      { language: "fr", start: 5, end: 10 }
    ],
    []
  ]
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          for (const languageSpans of annotations) {
            const input = { deliveryId: randomUUID(), text: "абвгдежзий", languageSpans }
            yield* conversation.send(input)
            const reply = yield* waitForReply(conversation, input.deliveryId)
            expect(reply.text).toBe("😀ok")
            expect(reply.languageSpans?.map((span) => [span.start, span.end])).toEqual([
              [0, 2],
              [2, 4]
            ])
            expect(reply.responseLanguage).toBe(requests.at(-1)?.responseLanguage)
          }
          expect(requests.map((request) => request.responseLanguage)).toEqual(["ru", "fr", "en"])
          expect(requests.map((request) => request.inputLanguageSpans)).toEqual(annotations)
          expect(requests.every((request) => request.input === "абвгдежзий")).toBe(true)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, provider)))
    )
  } finally {
    await fixture.close()
  }
})

it("retains partial output annotations through interruption and backend reopening", async () => {
  const fixture = await temporaryDatabase()
  const inputId = randomUUID()
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: () =>
      Stream.concat(
        Stream.succeed({ kind: "Delta", text: "bonjour", languageSpans: [{ language: "fr", start: 0, end: 7 }] }),
        Stream.never
      )
  })
  try {
    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({
            deliveryId: inputId,
            text: "bonjour",
            languageSpans: [{ language: "fr", start: 0, end: 7 }]
          })
          yield* conversation.observeReply(inputId)
          let state = yield* conversation.reply(inputId)
          for (let attempt = 0; state.state === "Waiting" && attempt < 100; attempt++) {
            yield* Effect.sleep(5)
            state = yield* conversation.reply(inputId)
          }
          expect(state.state).toBe("Streaming")
          yield* conversation.send({ deliveryId: randomUUID(), text: "next" })
          const stopped = yield* conversation.reply(inputId)
          expect(stopped.state).toBe("Interrupted")
          expect(stopped.receipt?.languageSpans).toEqual([{ language: "fr", start: 0, end: 7 }])
          return stopped.receipt
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, provider)))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const reply = yield* conversation.reply(inputId)
          expect(reply.state).toBe("Interrupted")
          expect(reply.receipt).toEqual(interrupted)
          expect(reply.languageSpans).toEqual(interrupted?.languageSpans)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer())))
    )
  } finally {
    await fixture.close()
  }
})

it("retries a failed answer with the durable original input annotations", async () => {
  const fixture = await temporaryDatabase()
  const requests: AnswerRequest[] = []
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: (request) => {
      requests.push(request)
      return requests.length === 1
        ? Stream.fail(new AnswerFailed({ message: "fixture failure" }))
        : Stream.make(
            { kind: "Delta", text: "oui", languageSpans: [{ language: "fr", start: 0, end: 3 }] },
            { kind: "Completed" }
          )
    }
  })
  const input = { deliveryId: randomUUID(), text: "salut", languageSpans: [{ language: "fr", start: 0, end: 5 }] }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Failed")
          yield* conversation.retryReply(input.deliveryId)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(requests.map((request) => request.inputLanguageSpans)).toEqual([
            input.languageSpans,
            input.languageSpans
          ])
          expect(requests.map((request) => request.responseLanguage)).toEqual(["fr", "fr"])
          expect(
            (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
          ).toHaveLength(1)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, provider)))
    )
  } finally {
    await fixture.close()
  }
})

it("persists whole-input detection separately from spans and freezes the accepted reply language", async () => {
  const fixture = await temporaryDatabase()
  const input = { deliveryId: randomUUID(), text: "Привет", detectedLanguage: "ru", languageSpans: [] }
  const requests: AnswerRequest[] = []
  const provider = (languages: readonly string[]) =>
    Layer.succeed(AnswerGeneration, {
      capabilities: { languages, output: "text-deltas" },
      generate: (request) => {
        requests.push(request)
        return Stream.fail(new AnswerFailed({ message: "fixture failure" }))
      }
    })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const receipt = yield* conversation.send(input)
          expect(receipt.detectedLanguage).toBe("ru")
          expect(receipt.languageSpans).toEqual([])
          expect(receipt.responseLanguage).toBe("ru")
          yield* waitForReply(conversation, input.deliveryId)
          const conflict = yield* Effect.flip(conversation.send({ ...input, detectedLanguage: "fr" }))
          expect(conflict._tag).toBe("DeliveryConflict")
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, provider(["ru", "en"]))))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const restored = yield* conversation.currentTurn()
          expect(restored?.input.detectedLanguage).toBe("ru")
          expect(restored?.input.responseLanguage).toBe("ru")
          expect(yield* conversation.send(input)).toEqual(restored?.input)
          yield* conversation.retryReply(input.deliveryId)
          const result = yield* waitForReply(conversation, input.deliveryId)
          expect(result.responseLanguage).toBe("ru")
          expect(result.state).toBe("Failed")
          expect(requests).toHaveLength(1)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, provider(["en"]))))
    )
  } finally {
    await fixture.close()
  }
})

it("validates detection tags and keeps unknown or unsupported detection honest", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const invalid = yield* Effect.flip(
            conversation.send({ deliveryId: randomUUID(), text: "hello", detectedLanguage: "bad_tag" })
          )
          expect(invalid._tag).toBe("InvalidInput")
          for (const detectedLanguage of [null, "de", "RU"]) {
            const receipt = yield* conversation.send({ deliveryId: randomUUID(), text: "hello", detectedLanguage })
            const reply = yield* waitForReply(conversation, receipt.deliveryId)
            expect(receipt.detectedLanguage).toBe(detectedLanguage === "RU" ? "ru" : detectedLanguage)
            expect(receipt.languageSpans).toEqual([])
            expect(reply.responseLanguage).toBe(detectedLanguage === "RU" ? "ru" : "en")
          }
          const input = { deliveryId: randomUUID(), text: "legacy" }
          const accepted = yield* conversation.send(input)
          expect(yield* conversation.send({ ...input, detectedLanguage: null })).toEqual(accepted)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer())))
    )
  } finally {
    await fixture.close()
  }
})
