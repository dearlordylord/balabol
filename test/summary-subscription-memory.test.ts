import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, configuredUniiLayer, sqliteLayer } from "../src/memory/index.ts"
import type { InferenceTransport } from "../src/subscription/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"
import { realSummaryFixture, summaryFrame, summaryResponse } from "./summary-subscription-fixture.ts"
const settings = { summaryProvider: "subscription", summaryModel: "gpt-6-luna", summaryConcurrency: 1 } as const
const first = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  text: "Synthetic durable memory facts. ".repeat(50)
}
const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "Follow-up synthetic input." }
const memoryLayer = (path: string, transport: InferenceTransport) =>
  configuredUniiLayer(settings).pipe(Layer.provide(realSummaryFixture(transport)), Layer.provide(sqliteLayer(path)))
const conversationLayer = (path: string, transport: InferenceTransport, attempts = 600, waitMillis = 100) =>
  Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeAnswerLayer(0),
        Layer.succeed(ReplyConfiguration, {
          ...defaultReplySettings,
          contextWaitAttempts: attempts,
          contextWaitMillis: waitMillis
        }),
        memoryLayer(path, transport)
      )
    )
  )
const waitReady = (memory: Memory["Service"], before: number) =>
  Effect.gen(function* () {
    let snapshot = yield* memory.snapshot(before)
    for (let index = 0; snapshot.state === "pending" && index < 300; index++) {
      yield* Effect.sleep(10)
      snapshot = yield* memory.snapshot(before)
    }
    return snapshot
  })
it("preserves pending ordering and duplicate identity, then restores completed real summaries without replaying them", async () => {
  const database = await temporaryDatabase()
  let release = (_response: Response) => {}
  let started = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  const transport: InferenceTransport = async () => {
    calls++
    if (calls === 1) {
      started()
      return pending
    }
    return summaryResponse()
  }
  let before = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* Memory
          const receipt = yield* memory.append(first)
          yield* Effect.promise(() => ready)
          expect((yield* memory.append(first)).position).toBe(receipt.position)
          const later = yield* memory.append(second)
          before = later.recordId
          expect((yield* memory.snapshot(before)).state).toBe("pending")
          release(summaryResponse())
          const snapshot = yield* waitReady(memory, before)
          expect(snapshot.state).toBe("ready")
          expect(snapshot.text).toContain("Retained synthetic memory")
          expect(yield* memory.page(undefined, 100)).toHaveLength(2)
        })
      ).pipe(Effect.provide(memoryLayer(database.path, transport)))
    )
    const completedCalls = calls
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* Memory
          expect((yield* memory.snapshot(before)).text).toContain("Retained synthetic memory")
          yield* memory.append(first)
          expect(yield* memory.page(undefined, 100)).toHaveLength(2)
        })
      ).pipe(Effect.provide(memoryLayer(database.path, transport)))
    )
    expect(calls).toBe(completedCalls)
  } finally {
    await database.close()
  }
})
it("answer cancellation leaves the independent real summary running and saved input available", async () => {
  const database = await temporaryDatabase()
  let release = (_response: Response) => {}
  let started = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  let summaryAborted = false
  const transport: InferenceTransport = async (_request, _token, signal) => {
    if (calls++ === 0) {
      signal.addEventListener(
        "abort",
        () => {
          summaryAborted = true
        },
        { once: true }
      )
      started()
      return pending
    }
    return summaryResponse()
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(first)
          yield* Effect.promise(() => ready)
          yield* conversation.send(second)
          expect((yield* conversation.reply(second.deliveryId)).state).toBe("Waiting")
          yield* conversation.cancelReply(second.deliveryId)
          expect(summaryAborted).toBe(false)
          release(summaryResponse())
          yield* Effect.sleep(100)
          expect((yield* conversation.reply(second.deliveryId)).error?.code).toBe("Cancelled")
          const page = yield* conversation.page({ limit: 100 })
          expect(page.messages.filter((message) => message.role === "user")).toHaveLength(2)
          yield* conversation.retryReply(second.deliveryId)
          expect((yield* waitForReply(conversation, second.deliveryId)).state).toBe("Completed")
          expect(
            (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
          ).toHaveLength(2)
        })
      ).pipe(Effect.provide(conversationLayer(database.path, transport)))
    )
  } finally {
    await database.close()
  }
})
it("a quota failure makes one call per job and explicit retry recovers accepted input without fallback", async () => {
  const database = await temporaryDatabase()
  let failing = true
  const jobAttempts: number[] = []
  const transport: InferenceTransport = async () => {
    jobAttempts.push(failing ? 0 : 1)
    return failing
      ? new Response(summaryFrame({ type: "response.failed", response: { error: { code: "insufficient_quota" } } }))
      : summaryResponse()
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* Memory
          yield* memory.append(first)
          const later = yield* memory.append(second)
          expect((yield* waitReady(memory, later.recordId)).state).toBe("failed")
          // A failed source job must not make five automatic provider calls.
          expect(jobAttempts.length).toBe(1)
          const failedCalls = jobAttempts.length
          yield* Effect.sleep(100)
          expect(jobAttempts).toHaveLength(failedCalls)
          failing = false
          expect(yield* memory.retryFailed()).toBeGreaterThan(0)
          expect((yield* waitReady(memory, later.recordId)).state).toBe("ready")
          expect(yield* memory.page(undefined, 100)).toHaveLength(2)
        })
      ).pipe(Effect.provide(memoryLayer(database.path, transport)))
    )
  } finally {
    await database.close()
  }
})
it("retains bounded unii refinement for oversized completed summaries", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  let feedbackSeen = false
  const transport: InferenceTransport = async (request) => {
    calls++
    const input: unknown = JSON.parse(request.input)
    if (calls > 1) feedbackSeen ||= JSON.stringify(input).includes("512")
    return summaryResponse(calls === 1 ? "x".repeat(600) : "Refined concise memory.")
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* Memory
          yield* memory.append(first)
          const later = yield* memory.append(second)
          expect((yield* waitReady(memory, later.recordId)).state).toBe("ready")
          expect(calls).toBeGreaterThan(1)
          expect(feedbackSeen).toBe(true)
        })
      ).pipe(Effect.provide(memoryLayer(database.path, transport)))
    )
  } finally {
    await database.close()
  }
})
it("a pending-context timeout retains accepted input and requires explicit retry after late readiness", async () => {
  const database = await temporaryDatabase()
  let release = (_response: Response) => {}
  let started = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  const transport: InferenceTransport = async () => {
    if (calls++ === 0) {
      started()
      return pending
    }
    return summaryResponse()
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(first)
          yield* Effect.promise(() => ready)
          yield* conversation.send(second)
          const failed = yield* waitForReply(conversation, second.deliveryId)
          expect(failed.error?.code).toBe("MemoryPending")
          release(summaryResponse())
          yield* Effect.sleep(100)
          expect(yield* conversation.reply(second.deliveryId)).toEqual(failed)
          yield* conversation.retryReply(second.deliveryId)
          expect((yield* waitForReply(conversation, second.deliveryId)).state).toBe("Completed")
          expect(
            (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
          ).toHaveLength(2)
        })
      ).pipe(Effect.provide(conversationLayer(database.path, transport, 1, 1)))
    )
  } finally {
    await database.close()
  }
})
it("composes both real providers with one scoped credential writer without running inference", async () => {
  const database = await temporaryDatabase()
  const { dirname, join } = await import("node:path")
  const { conversationLayer: configuredConversation } = await import("../src/bootstrap/index.ts")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          configuredConversation(
            database.path,
            { ...defaultReplySettings, answerProvider: "subscription", answerModel: "gpt-6.1-sol" },
            settings,
            undefined,
            join(dirname(database.path), "private-subscription")
          )
        )
      )
    )
  } finally {
    await database.close()
  }
})
