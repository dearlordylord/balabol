import { Effect, Layer, Schema, Stream } from "effect"
import { expect, it } from "vitest"
import {
  AnswerEvent,
  AnswerFailed,
  AnswerGeneration,
  AnswerRequest,
  fakeAnswerLayer
} from "../src/answer-generation/index.ts"
import { Conversation, Reply, defaultReplySettings } from "../src/conversation/index.ts"
import { DeliveryPayload, Receipt } from "../src/memory/index.ts"
import { parseConfig } from "../src/bootstrap/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "bonjour" }
const later = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "salut" }
it("passes exclusive prior memory and the current input exactly once and reconstructs completed replies", async () => {
  const fixture = await temporaryDatabase()
  const requests: AnswerRequest[] = []
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: (request) => {
      requests.push(request)
      return Stream.fromIterable([
        { kind: "Delta", text: "a short reply", languageSpans: [] },
        { kind: "Completed" }
      ] satisfies AnswerEvent[])
    }
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Completed")
          yield* conversation.send(later)
          expect((yield* waitForReply(conversation, later.deliveryId)).state).toBe("Completed")
          expect(requests[0]?.prior).toBe("<chat>\n</chat>")
          expect(requests[0]?.input).toBe("bonjour")
          expect(requests[1]?.prior).toContain("bonjour")
          expect(requests[1]?.prior).toContain("a short reply")
          expect(requests[1]?.prior).not.toContain("salut")
          expect(requests[1]?.input).toBe("salut")
          expect(requests[1]?.capabilities).toEqual(["memory.context"])
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, answer)))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const restored = yield* conversation.reply(input.deliveryId)
          expect(restored.state).toBe("Completed")
          expect((yield* conversation.send(input)).role).toBe("user")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(4)
          if (restored.receipt !== null)
            expect(
              (yield* Effect.flip(conversation.send({ deliveryId: restored.receipt.deliveryId, text: restored.text })))
                ._tag
            ).toBe("DeliveryConflict")
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, answer)))
    )
    expect(requests).toHaveLength(2)
  } finally {
    await fixture.close()
  }
})

const invalidStreams = [
  { name: "missing terminal", events: [{ kind: "Delta", text: "partial", languageSpans: [] }] },
  {
    name: "events after terminal",
    events: [
      { kind: "Delta", text: "partial", languageSpans: [] },
      { kind: "Completed" },
      { kind: "Delta", text: "late", languageSpans: [] }
    ]
  },
  { name: "empty completed", events: [{ kind: "Completed" }] }
] satisfies { name: string; events: AnswerEvent[] }[]
for (const example of invalidStreams)
  it(`rejects ${example.name} without persisting successful history`, async () => {
    const fixture = await temporaryDatabase()
    try {
      const answer = Layer.succeed(AnswerGeneration, {
        capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
        generate: () => Stream.fromIterable(example.events)
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.send(input)
            expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Failed")
            expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
          })
        ).pipe(Effect.provide(replyLayer(fixture.path, answer)))
      )
    } finally {
      await fixture.close()
    }
  })
it("cancels a suspended provider without masking interruption and ignores stale observers", async () => {
  const fixture = await temporaryDatabase()
  try {
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () =>
        Stream.concat(
          Stream.succeed({ kind: "Delta", text: "partial", languageSpans: [] } satisfies AnswerEvent),
          Stream.fromEffect(Effect.never)
        )
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          const stale = yield* conversation.observeReply(input.deliveryId)
          const active = yield* conversation.observeReply(input.deliveryId)
          yield* conversation.releaseReply(input.deliveryId, stale)
          expect((yield* conversation.reply(input.deliveryId)).state).not.toBe("Failed")
          yield* conversation.releaseReply(input.deliveryId, active)
          expect((yield* conversation.reply(input.deliveryId)).state).toBe("Failed")
          yield* conversation.send(later)
          yield* conversation.cancelReply(later.deliveryId)
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.role)).toEqual([
            "user",
            "user"
          ])
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, answer)))
    )
  } finally {
    await fixture.close()
  }
})
it("surfaces provider failure after partial text and bounds unattached responses", async () => {
  const fixture = await temporaryDatabase()
  try {
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () =>
        Stream.concat(
          Stream.succeed({ kind: "Delta", text: "partial", languageSpans: [] } satisfies AnswerEvent),
          Stream.fail(new AnswerFailed({ message: "provider offline" }))
        )
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          const failed = yield* waitForReply(conversation, input.deliveryId)
          expect(failed.text).toBe("partial")
          expect(failed.error?.message).toBe("provider offline")
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, answer)))
    )
  } finally {
    await fixture.close()
  }
})
it("validates unsupported capabilities, dependent reply data and startup policy", async () => {
  expect(() =>
    Schema.decodeUnknownSync(AnswerRequest)({
      model: "sol",
      prior: "",
      input: "hello",
      inputLanguageSpans: [],
      responseLanguage: "en",
      capabilities: ["filesystem.read"]
    })
  ).toThrow()
  expect(() => Schema.decodeUnknownSync(AnswerEvent)({ kind: "Delta", text: "", languageSpans: [] })).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(Reply)({
      responseId: input.deliveryId,
      inputDeliveryId: input.deliveryId,
      sequence: 0,
      state: "Waiting",
      text: "illegal",
      error: null,
      receipt: null
    })
  ).toThrow()
  expect((await Effect.runPromise(Effect.flip(parseConfig({ BALABOL_PRIOR_CONTEXT_WAIT_ATTEMPTS: "0" }))))._tag).toBe(
    "SchemaError"
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* AnswerGeneration
      const invalid = yield* Effect.flip(
        Stream.runCollect(
          provider.generate({
            model: defaultReplySettings.answerModel,
            prior: "",
            input: "hello",
            inputLanguageSpans: [],
            responseLanguage: "en",
            capabilities: ["memory.context", "memory.context"]
          })
        )
      )
      expect(invalid._tag).toBe("AnswerFailed")
    }).pipe(Effect.provide(fakeAnswerLayer(0)))
  )
})

it("cancels generation when no observer attaches within the configured deadline", async () => {
  const fixture = await temporaryDatabase()
  try {
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () => Stream.fromEffect(Effect.never)
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          const failed = yield* waitForReply(conversation, input.deliveryId)
          expect(failed.state).toBe("Failed")
          expect(failed.error?.code).toBe("Cancelled")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, answer, { attachmentMillis: 20 })))
    )
  } finally {
    await fixture.close()
  }
})

it("rejects incomplete or contradictory assistant identities at memory boundaries", () => {
  const base = { deliveryId: input.deliveryId, recordId: 0, position: 0, text: "reply" }
  expect(() => Schema.decodeUnknownSync(Receipt)({ ...base, role: "assistant" })).toThrow()
  expect(() => Schema.decodeUnknownSync(Receipt)({ ...base, role: "user", outcome: "interrupted" })).toThrow()
  expect(() => Schema.decodeUnknownSync(DeliveryPayload)({ ...input, text: "" })).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(DeliveryPayload)({
      ...input,
      text: "",
      role: "assistant",
      inputDeliveryId: later.deliveryId,
      responseId: input.deliveryId,
      outcome: "completed"
    })
  ).toThrow()
  expect(() => Schema.decodeUnknownSync(Receipt)({ ...base, role: "user", responseId: input.deliveryId })).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(DeliveryPayload)({
      ...input,
      role: "assistant",
      inputDeliveryId: later.deliveryId,
      responseId: later.deliveryId
    })
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(DeliveryPayload)({
      ...input,
      role: "assistant",
      inputDeliveryId: input.deliveryId,
      responseId: input.deliveryId
    })
  ).toThrow()
})

it("rejects an otherwise valid reply envelope that aliases its accepted input identity", () => {
  const snapshot = {
    responseId: input.deliveryId,
    inputDeliveryId: input.deliveryId,
    sequence: 0,
    state: "Waiting",
    text: "",
    languageSpans: [],
    error: null,
    receipt: null
  }
  expect(() => Schema.decodeUnknownSync(Reply)(snapshot)).toThrow()
  expect(Schema.decodeUnknownSync(Reply)({ ...snapshot, responseId: later.deliveryId })).toMatchObject({
    state: "Waiting"
  })
})

it("rejects contradictory terminal language metadata while each span set is independently valid", () => {
  const receipt = {
    deliveryId: later.deliveryId,
    recordId: 1,
    position: 1,
    text: "hello",
    role: "assistant",
    inputDeliveryId: input.deliveryId,
    responseId: later.deliveryId,
    outcome: "completed",
    languageSpans: [{ language: "en", start: 0, end: 5 }]
  }
  const snapshot = {
    responseId: later.deliveryId,
    inputDeliveryId: input.deliveryId,
    sequence: 2,
    state: "Completed",
    text: receipt.text,
    languageSpans: receipt.languageSpans,
    error: null,
    receipt
  }
  expect(Schema.decodeUnknownSync(Reply)(snapshot)).toMatchObject({ state: "Completed" })
  expect(() =>
    Schema.decodeUnknownSync(Reply)({ ...snapshot, languageSpans: [{ language: "fr", start: 0, end: 5 }] })
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(Reply)({ ...snapshot, languageSpans: [{ language: "en", start: 1, end: 5 }] })
  ).toThrow()
})
