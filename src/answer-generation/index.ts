import { Context, Effect, Layer, Schema, Stream } from "effect"

const MODEL_NAME_LIMIT = 200
const PRIOR_CONTEXT_LIMIT = 1000000
const ANSWER_TEXT_LIMIT = 100000
const MAX_FAKE_DELAY_MILLIS = 60000
const FAKE_INPUT_PREVIEW_LIMIT = 160
const DEFAULT_FAKE_DELAY_MILLIS = 80

// Grounding: research/subscription-model-integration.md (Codex 0.162.1);
// slopchat-codex.el turn/start, turn/interrupt and agentMessage/delta.
// Codex turn/item streaming adapter boundary: prior context is exclusive of current input.
// No SDK tool router is accepted. Future tools must implement this bounded named capability.
export const AnswerRequest = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MODEL_NAME_LIMIT)),
  prior: Schema.String.check(Schema.isMaxLength(PRIOR_CONTEXT_LIMIT)),
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ANSWER_TEXT_LIMIT)),
  capabilities: Schema.Array(Schema.Literal("memory.context")).check(Schema.isMaxLength(1))
})
export type AnswerRequest = typeof AnswerRequest.Type
export const AnswerEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("Delta"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ANSWER_TEXT_LIMIT))
  }),
  Schema.Struct({ kind: Schema.Literal("Completed") })
])
export type AnswerEvent = typeof AnswerEvent.Type
export class AnswerFailed extends Schema.TaggedError<AnswerFailed>()("AnswerFailed", { message: Schema.String }) {}
export class AnswerGeneration extends Context.Service<
  AnswerGeneration,
  { generate: (request: AnswerRequest) => Stream.Stream<AnswerEvent, AnswerFailed> }
>()("balabol/answer-generation") {}
const FakeDelayMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_FAKE_DELAY_MILLIS)
)

export const fakeAnswerLayer = (delayMillis = DEFAULT_FAKE_DELAY_MILLIS) =>
  Layer.effect(
    AnswerGeneration,
    Schema.decodeUnknownEffect(FakeDelayMillis)(delayMillis).pipe(
      Effect.mapError(() => new AnswerFailed({ message: "Invalid fake answer delay" })),
      Effect.map((delay) =>
        AnswerGeneration.of({
          generate: (raw) =>
            Stream.unwrap(
              Schema.decodeUnknownEffect(AnswerRequest)(raw).pipe(
                Effect.mapError(() => new AnswerFailed({ message: "Unsupported answer request or capability" })),
                Effect.map((request) => {
                  const text = `[Fake ${request.model}] ${request.input.slice(0, FAKE_INPUT_PREVIEW_LIMIT)}\nPrior memory: ${request.prior === "<chat>\n</chat>" ? "(empty)" : `${request.prior.length} characters available`}`
                  const chunks = text.match(/.{1,24}/gs) ?? []
                  return Stream.fromIterable(chunks).pipe(
                    Stream.mapEffect((chunk) =>
                      Effect.sleep(delay).pipe(
                        Effect.andThen(
                          Schema.encodeEffect(AnswerEvent)({ kind: "Delta", text: chunk }).pipe(
                            Effect.mapError(() => new AnswerFailed({ message: "Invalid answer delta" }))
                          )
                        )
                      )
                    ),
                    Stream.concat(
                      Stream.fromEffect(
                        Schema.encodeEffect(AnswerEvent)({ kind: "Completed" }).pipe(
                          Effect.mapError(() => new AnswerFailed({ message: "Invalid answer terminal" }))
                        )
                      )
                    )
                  )
                })
              )
            )
        })
      )
    )
  )
