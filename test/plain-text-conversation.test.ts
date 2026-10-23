import { Deferred, Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerFailed, AnswerGeneration, type AnswerEvent } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { outputInput, waitForOutput, withVoiceOutput } from "./voice-output-fixture.ts"

const markdown = "# Bonjour\n\n**Привет** et *salut*.\n- 日本語\n`C#` et 2 * 3.\n"
const plain = "Bonjour\n\nПривет et salut.\n日本語\nC# et 2 * 3.\n"
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const deltas: readonly AnswerEvent[] = [
  ...Array.from(markdown, (text): AnswerEvent => ({ kind: "Delta", text, languageSpans: [] })),
  { kind: "Completed" }
]

it("enforces plain text despite ignored instructions and restores the same durable reply", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const answer = knowledgeAnswerLayer(async (request) => {
    calls++
    expect(request.instructions).toContain("Use plain spoken text without Markdown formatting.")
    return new Response(
      Array.from(markdown, (delta) => event({ type: "response.output_text.delta", delta })).join("") +
        event({ type: "response.completed", response: { status: "completed", output: [] } })
    )
  })
  const application = replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(outputInput)
          const reply = yield* waitForReply(conversation, outputInput.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe(plain)
          expect(reply.receipt?.text).toBe(plain)
          expect((yield* conversation.page({ limit: 100 })).messages[1]?.text).toBe(plain)
        })
      ).pipe(Effect.provide(application))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* conversation.reply(outputInput.deliveryId)).text).toBe(plain)
          expect((yield* conversation.page({ limit: 100 })).messages[1]?.text).toBe(plain)
        })
      ).pipe(Effect.provide(application))
    )
    expect(calls).toBe(1)
  } finally {
    await database.close()
  }
})

it("passes the same admitted plain text to actual Voice phrase synthesis and durable chat", () => {
  const phrases: string[] = []
  const synthesis = Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      return SpeechSynthesis.of({
        capabilities: provider.capabilities,
        synthesize: (request) => {
          phrases.push(request.text)
          return provider.synthesize(request)
        }
      })
    })
  ).pipe(Layer.provide(fakeSynthesisLayer({ delayMillis: 0 })))
  return withVoiceOutput(
    () =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const output = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (output?.manifest == null) throw new Error("Missing output publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect(phrases.join(" ").replace(/\s+/gu, " ").trim()).toBe(plain.replace(/\s+/gu, " ").trim())
        expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.text).toBe(plain)
      }),
    synthesis,
    Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en", "ja"], output: "text-deltas" },
      generate: () => Stream.fromIterable(deltas)
    })
  )
})

it.each(["failure", "cancellation"])("does not publish an undecided formatting suffix after %s", async (outcome) => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const answer = Layer.succeed(AnswerGeneration, {
          capabilities: { languages: ["en"], output: "text-deltas" },
          generate: () =>
            Stream.fromIterable<AnswerEvent>([
              { kind: "Delta", text: "Visible. **unfinished", languageSpans: [] }
            ]).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                ).pipe(Stream.flatMap(() => Stream.fail(new AnswerFailed({ message: "Synthetic failure" }))))
              )
            )
        })
        yield* Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(outputInput)
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          let streaming = yield* conversation.reply(outputInput.deliveryId)
          for (let attempt = 0; streaming.text === "" && streaming.state !== "Failed" && attempt < 200; attempt++) {
            yield* Effect.sleep(5)
            streaming = yield* conversation.reply(outputInput.deliveryId)
          }
          expect(streaming.text).toBe("Visible. ")
          if (outcome === "cancellation") yield* conversation.cancelReply(outputInput.deliveryId)
          yield* Deferred.succeed(release, undefined)
          const reply = yield* waitForReply(conversation, outputInput.deliveryId)
          expect(reply.state).toBe("Failed")
          expect(reply.text).toBe("Visible. ")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.scoped,
          Effect.provide(replyLayer(database.path, answer))
        )
      })
    )
  } finally {
    await database.close()
  }
})

it("rejects total reply annotations beyond capacity even when each plain delta is independently valid", async () => {
  const database = await temporaryDatabase()
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en"], output: "text-deltas" },
    generate: () =>
      Stream.fromIterable<AnswerEvent>([
        ...Array.from(
          { length: 2 },
          (): AnswerEvent => ({
            kind: "Delta",
            text: "a ".repeat(500),
            languageSpans: Array.from({ length: 500 }, (_, index) => ({
              language: "en",
              start: index * 2,
              end: index * 2 + 1
            }))
          })
        ),
        { kind: "Delta", text: "a", languageSpans: [{ language: "en", start: 0, end: 1 }] },
        { kind: "Completed" }
      ])
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(outputInput)
          const reply = yield* waitForReply(conversation, outputInput.deliveryId)
          expect(reply.state).toBe("Failed")
          expect(reply.error?.message).toBe("Provider output exceeds bounded valid text and annotations")
          expect(reply.text).toBe("a ".repeat(1000))
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        })
      ).pipe(Effect.provide(replyLayer(database.path, answer)))
    )
  } finally {
    await database.close()
  }
})
