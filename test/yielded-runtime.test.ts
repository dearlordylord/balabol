import { it } from "@effect/vitest"
import * as Agent from "@yielded/agent/agent"
import { AgentPolicy } from "@yielded/agent/agent-policy"
import * as AgentRuntime from "@yielded/agent/agent-runtime"
import * as InMemory from "@yielded/agent/in-memory"
import * as Output from "@yielded/agent/output"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, Model, type Prompt, type Response, Tool, Toolkit } from "effect/ai"
import { describe, expect } from "vitest"

const tools = Toolkit.make(Tool.make("inspect_knowledge", { parameters: Schema.Struct({}), success: Schema.String }))

const definition = Agent.make("balabol-cohort-smoke", {
  input: Schema.String,
  output: Output.text(Schema.String),
  instructions: "Inspect knowledge, then answer using the result.",
  toolkit: tools,
  policy: AgentPolicy.make({ maxTurns: 2, maxToolCalls: 1, maxDuration: "10 seconds", toolConcurrency: 1 })
})

const answerParts = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } }
]

const toolResult = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .find((part) => part.type === "tool-result")

const fakeModel = (prompts: Ref.Ref<ReadonlyArray<Prompt.Prompt>>) =>
  Model.make(
    "balabol-test",
    "synthetic-tools",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: ({ prompt }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Ref.update(prompts, (previous) => [...previous, prompt])
              const result = toolResult(prompt)
              return Stream.fromIterable<Response.StreamPartEncoded>(
                result === undefined
                  ? [
                      {
                        type: "tool-call",
                        id: "inspect-1",
                        name: "inspect_knowledge",
                        params: {},
                        providerExecuted: false
                      },
                      { type: "finish", reason: "tool-calls", usage: { inputTokens: {}, outputTokens: {} } }
                    ]
                  : answerParts(`Knowledge: ${String(result.result)}`)
              )
            })
          )
      })
    )
  )

describe("the pinned Yielded and Effect cohort", () => {
  it.effect("returns ordinary text derived from an explicitly provided tool result", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
      const calls = yield* Ref.make(0)
      const events = yield* AgentRuntime.stream(
        Agent.withModel(definition, fakeModel(prompts)),
        "Synthetic context: practice French bread vocabulary."
      ).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            InMemory.layer,
            tools.toLayer({
              inspect_knowledge: () =>
                Ref.update(calls, (count) => count + 1).pipe(Effect.as("French pain means bread"))
            })
          )
        )
      )
      expect(
        events
          .filter((event) => event._tag === "TextDelta")
          .map((event) => event.text)
          .join("")
      ).toBe("Knowledge: French pain means bread")
      expect(events.at(-1)).toMatchObject({ _tag: "RunCompleted", output: "Knowledge: French pain means bread" })
      expect(yield* Ref.get(calls)).toBe(1)
      const observed = yield* Ref.get(prompts)
      expect(observed).toHaveLength(2)
      expect(JSON.stringify(observed[0])).toContain("Synthetic context: practice French bread vocabulary.")
      const followup = observed[1]
      expect(followup === undefined ? undefined : toolResult(followup)).toMatchObject({
        result: "French pain means bread"
      })
    })
  )

  it.effect("interrupts the pending tool and runs its cleanup when the scoped run is cancelled", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
      const entered = yield* Deferred.make<void>()
      const released = yield* Ref.make(false)
      const fiber = yield* AgentRuntime.run(Agent.withModel(definition, fakeModel(prompts)), "Inspect.").pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemory.layer,
            tools.toLayer({
              inspect_knowledge: () =>
                Effect.acquireUseRelease(
                  Deferred.succeed(entered, undefined),
                  () => Effect.never,
                  () => Ref.set(released, true)
                )
            })
          )
        ),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* Ref.get(released)).toBe(true)
      expect(yield* Ref.get(prompts)).toHaveLength(1)
    })
  )
})
