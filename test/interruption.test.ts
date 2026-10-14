import type { Storage } from "@firfi/unii"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { AnswerGeneration, type AnswerEvent, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SummaryGeneration, fakeSummaryLayer } from "../src/summary-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { decoratedConversation, temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

const first = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "first" }
const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "second" }
it.effect(
  "settles collected output before the next input and duplicate delivery cannot interrupt the newer reply",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(temporaryDatabase)
      yield* Effect.gen(function* () {
        const conversation = yield* Conversation
        yield* conversation.send({ ...first, languageSpans: [{ language: "fr", start: 0, end: first.text.length }] })
        yield* conversation.observeReply(first.deliveryId)
        yield* TestClock.adjust(100)
        const streaming = yield* conversation.reply(first.deliveryId)
        expect(streaming.state).toBe("Streaming")
        yield* conversation.send(second)
        yield* conversation.observeReply(second.deliveryId)
        const interrupted = yield* conversation.reply(first.deliveryId)
        expect(interrupted.state).toBe("Interrupted")
        expect(interrupted.sequence).toBeGreaterThan(streaming.sequence)
        expect(interrupted.text).toBe(streaming.text)
        expect(interrupted.receipt?.outcome).toBe("interrupted")
        expect(interrupted.languageSpans).toEqual(streaming.languageSpans)
        expect(interrupted.receipt?.languageSpans).toEqual(streaming.languageSpans)
        yield* conversation.send({ ...first, languageSpans: [{ language: "fr", start: 0, end: first.text.length }] })
        expect((yield* conversation.reply(second.deliveryId)).state).not.toBe("Interrupted")
        yield* TestClock.adjust(2000)
        const messages = (yield* conversation.page({ limit: 100 })).messages
        expect(messages.slice(0, 3).map((message) => [message.role, message.text, message.outcome])).toEqual([
          ["user", "first", undefined],
          ["assistant", streaming.text, "interrupted"],
          ["user", "second", undefined]
        ])
        expect((yield* conversation.reply(first.deliveryId)).text).toBe(streaming.text)
      }).pipe(
        Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(100))),
        Effect.scoped,
        Effect.ensuring(Effect.promise(() => fixture.close()))
      )
    })
)
it.effect("persists an empty interrupted outcome when new text arrives before any reply output", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.send(second)
      const reply = yield* conversation.reply(first.deliveryId)
      expect(reply.state).toBe("Interrupted")
      expect(reply.text).toBe("")
      expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual([
        "first",
        "",
        "second"
      ])
    }).pipe(
      Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(100))),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)

it.effect("passes interrupted generated text and its honest semantic marker into the next answer context", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: (request) =>
        request.input === "first"
          ? Stream.concat(
              Stream.succeed({ kind: "Delta", text: "Generated proposal", languageSpans: [] }),
              Stream.never
            )
          : Stream.make({ kind: "Delta", text: request.prior, languageSpans: [] }, { kind: "Completed" })
    })
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(1)
      yield* conversation.send(second)
      yield* conversation.observeReply(second.deliveryId)
      yield* TestClock.adjust(1)
      const reply = yield* conversation.reply(second.deliveryId)
      expect(reply.state).toBe("Completed")
      expect(reply.text).toContain("assistant_interrupted: Generated proposal")
      expect(reply.text).toContain("generated text may not have been heard; no user agreement implied")
      expect(reply.text).toContain("first")
      expect(reply.text).not.toContain("second")
    }).pipe(
      Effect.provide(replyLayer(fixture.path, answer)),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
it.effect("blocks new admission on interrupted storage failure and resumes its frozen settlement after restart", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    let failInterrupted = true
    const decorate = (storage: Storage): Storage => ({
      open: () => storage.open(),
      close: () => storage.close(),
      load: () => storage.load(),
      appendRecords: async (records) => {
        if (failInterrupted && records.some((record) => record.kind === "assistant_interrupted"))
          throw new Error("Injected interrupted write failure")
        await storage.appendRecords(records)
      },
      appendNode: (node) => storage.appendNode(node),
      checkpoint: (value) => storage.checkpoint(value)
    })
    const attempt = Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(80)
      const frozen = yield* conversation.reply(first.deliveryId)
      expect((yield* Effect.flip(conversation.send(second)))._tag).toBe("StorageUnavailable")
      yield* TestClock.adjust(1000)
      expect((yield* Effect.flip(conversation.send(second)))._tag).toBe("StorageUnavailable")
      expect((yield* conversation.reply(first.deliveryId)).text).toBe(frozen.text)
      expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual(["first"])
      return frozen.text
    }).pipe(Effect.provide(decoratedConversation(fixture.path, decorate)), Effect.scoped)
    yield* Effect.gen(function* () {
      const frozenText = yield* attempt
      failInterrupted = false
      yield* Effect.gen(function* () {
        const conversation = yield* Conversation
        yield* conversation.send(second)
        const reply = yield* conversation.reply(first.deliveryId)
        expect(reply.state).toBe("Interrupted")
        expect(reply.text).toBe(frozenText)
        yield* conversation.send(second)
        expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual([
          "first",
          frozenText,
          "second"
        ])
      }).pipe(Effect.provide(decoratedConversation(fixture.path, decorate)), Effect.scoped)
    }).pipe(Effect.ensuring(Effect.promise(() => fixture.close())))
  })
)
it.effect("freezes before cancellation acknowledgement and rejects delayed provider output", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () =>
        Stream.concat(
          Stream.succeed({ kind: "Delta", text: "collected", languageSpans: [] } satisfies AnswerEvent),
          Stream.fromEffect(
            Effect.sleep(100).pipe(
              Effect.as({ kind: "Delta", text: "late", languageSpans: [] } satisfies AnswerEvent),
              Effect.uninterruptible
            )
          )
        ).pipe(Stream.concat(Stream.succeed({ kind: "Completed" } satisfies AnswerEvent)))
    })
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(1)
      const sending = yield* Effect.forkChild(conversation.send(second))
      yield* TestClock.adjust(1)
      const frozen = yield* conversation.reply(first.deliveryId)
      expect(frozen.text).toBe("collected")
      expect(frozen.state).toBe("Streaming")
      yield* TestClock.adjust(100)
      yield* Fiber.join(sending)
      const interrupted = yield* conversation.reply(first.deliveryId)
      expect(interrupted.state).toBe("Interrupted")
      expect(interrupted.text).toBe("collected")
      expect((yield* conversation.page({ limit: 100 })).messages[1]?.text).toBe("collected")
      yield* TestClock.adjust(100)
    }).pipe(
      Effect.provide(replyLayer(fixture.path, answer)),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
it.effect("keeps completed output when provider completion wins before the new send", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(1000)
      expect((yield* conversation.reply(first.deliveryId)).state).toBe("Completed")
      yield* conversation.send(second)
      expect((yield* conversation.reply(first.deliveryId)).state).toBe("Completed")
      expect((yield* conversation.page({ limit: 100 })).messages[1]?.outcome).toBe("completed")
    }).pipe(
      Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(10))),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
it.effect("lets an already committing completion settle before the next input", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const decorate = (storage: Storage): Storage => ({
      open: () => storage.open(),
      close: () => storage.close(),
      load: () => storage.load(),
      appendRecords: async (records) => {
        if (records.some((record) => record.kind === "assistant")) {
          await Effect.runPromise(Deferred.succeed(entered, undefined))
          await Effect.runPromise(Deferred.await(release))
        }
        await storage.appendRecords(records)
      },
      appendNode: (node) => storage.appendNode(node),
      checkpoint: (value) => storage.checkpoint(value)
    })
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(1000)
      yield* Deferred.await(entered)
      const sending = yield* Effect.forkChild(conversation.send(second))
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sending)
      expect((yield* conversation.reply(first.deliveryId)).state).toBe("Completed")
      expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.outcome)).toEqual([
        undefined,
        "completed",
        undefined
      ])
    }).pipe(
      Effect.provide(decoratedConversation(fixture.path, decorate)),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
it.effect("keeps independent compaction running while interrupting the answer", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    const summary = Layer.effect(
      SummaryGeneration,
      Effect.gen(function* () {
        const real = yield* SummaryGeneration
        return SummaryGeneration.of({
          summarize: (request) => Effect.sleep(1000).pipe(Effect.andThen(real.summarize(request)))
        })
      })
    ).pipe(Layer.provide(fakeSummaryLayer))
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: (request) =>
        request.input === "second"
          ? Stream.make({ kind: "Delta", text: request.prior, languageSpans: [] }, { kind: "Completed" })
          : Stream.concat(Stream.succeed({ kind: "Delta", text: "generated", languageSpans: [] }), Stream.never)
    })
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send({ ...first, text: "Large accepted memory. ".repeat(200) })
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(20)
      yield* conversation.send(second)
      yield* conversation.observeReply(second.deliveryId)
      yield* TestClock.adjust(2000)
      const reply = yield* conversation.reply(second.deliveryId)
      expect(reply.state).toBe("Completed")
      expect(reply.text).toContain("generated text may not have been heard; no user agreement implied")
      expect(reply.text).toContain("generated")
    }).pipe(
      Effect.provide(replyLayer(fixture.path, answer, {}, summary)),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
it.effect("settles a failed completed write before admitting the next input", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    let failing = true
    const decorate = (storage: Storage): Storage => ({
      open: () => storage.open(),
      close: () => storage.close(),
      load: () => storage.load(),
      appendRecords: async (records) => {
        if (failing && records.some((record) => record.kind === "assistant"))
          throw new Error("Injected completed write failure")
        await storage.appendRecords(records)
      },
      appendNode: (node) => storage.appendNode(node),
      checkpoint: (value) => storage.checkpoint(value)
    })
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send(first)
      yield* conversation.observeReply(first.deliveryId)
      yield* TestClock.adjust(1000)
      expect((yield* conversation.reply(first.deliveryId)).error?.code).toBe("StorageUnavailable")
      expect((yield* Effect.flip(conversation.send(second)))._tag).toBe("StorageUnavailable")
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
      failing = false
      yield* conversation.send(second)
      expect((yield* conversation.reply(first.deliveryId)).state).toBe("Completed")
      expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.outcome)).toEqual([
        undefined,
        "completed",
        undefined
      ])
    }).pipe(
      Effect.provide(decoratedConversation(fixture.path, decorate)),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
