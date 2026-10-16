import { Effect, Schema, Stream } from "effect"
import { Receipt, samePayload, StorageUnavailable, type Memory } from "../memory/index.ts"
import type { AnswerGeneration } from "../answer-generation/index.ts"
import { parseAnswerEvent, validateAnswerLanguages } from "./answer-languages.ts"
import { waitForPriorMemory } from "./prior-context.ts"
import { appendReply } from "./reply-persistence.ts"
import type { ResponseCommand, ResponseEvent } from "./response-events.ts"
import type { ReplySettings } from "./reply-configuration.ts"

type Post = (event: ResponseEvent) => Effect.Effect<void>
export const generateResponse = (
  command: Extract<ResponseCommand, { kind: "Generate" }>,
  answer: AnswerGeneration["Service"],
  settings: ReplySettings,
  post: Post,
  authorized: () => boolean
) => {
  const permitted = Effect.suspend(() => (authorized() ? Effect.void : Effect.interrupt))
  const prior = /^[0-9]+\+[0-9]+\|assistant_interrupted:/m.test(command.prior)
    ? `[Interrupted assistant output: generated text may not have been heard; no user agreement implied]\n${command.prior}`
    : command.prior
  return permitted.pipe(
    Effect.andThen(validateAnswerLanguages(answer.capabilities, command.responseLanguage, command.input.languageSpans)),
    Effect.andThen(
      Effect.suspend(() =>
        authorized()
          ? answer
              .generate({
                inputDeliveryId: command.input.deliveryId,
                responseId: command.responseId,
                model: settings.answerModel,
                prior,
                input: command.input.text,
                inputLanguageSpans: command.input.languageSpans,
                responseLanguage: command.responseLanguage,
                capabilities: ["memory.context"]
              })
              .pipe(
                Stream.runForEach((raw) =>
                  permitted.pipe(
                    Effect.andThen(parseAnswerEvent(raw, answer.capabilities)),
                    Effect.flatMap((event) =>
                      post({ kind: "ProviderEvent", attempt: command.attempt, operation: command.operation, event })
                    )
                  )
                )
              )
          : Effect.interrupt
      )
    ),
    Effect.andThen(permitted),
    Effect.andThen(post({ kind: "ProviderEnded", attempt: command.attempt, operation: command.operation }))
  )
}
export const prepareResponseContext = (
  command: Extract<ResponseCommand, { kind: "PrepareContext" }>,
  memory: Memory["Service"],
  settings: ReplySettings,
  post: Post
) =>
  waitForPriorMemory(memory, command.input.recordId, settings).pipe(
    Effect.flatMap((snapshot) => post({ ...command, kind: "ContextReady", snapshot }))
  )
const verifyReceipt = (raw: unknown, payload: Extract<ResponseCommand, { kind: "PersistTerminal" }>["payload"]) =>
  Schema.decodeUnknownEffect(Receipt)(raw).pipe(
    Effect.mapError(() => new StorageUnavailable({ message: "Malformed terminal storage receipt" })),
    Effect.flatMap((receipt) =>
      samePayload(receipt, payload)
        ? Effect.succeed(receipt)
        : Effect.fail(new StorageUnavailable({ message: "Terminal storage receipt mismatches selected intent" }))
    )
  )
export const persistResponseTerminal = (
  command: Extract<ResponseCommand, { kind: "PersistTerminal" }>,
  memory: Memory["Service"],
  post: Post
) => {
  const preceding =
    command.payload.outcome === "interrupted"
      ? memory
          .pendingReply()
          .pipe(
            Effect.flatMap((pending) =>
              pending === undefined ? Effect.void : appendReply(memory, pending).pipe(Effect.asVoid)
            )
          )
      : Effect.void
  return preceding.pipe(
    Effect.andThen(appendReply(memory, command.payload)),
    Effect.flatMap((raw) => verifyReceipt(raw, command.payload)),
    Effect.flatMap((receipt) => post({ ...command, kind: "TerminalStored", receipt })),
    Effect.catch((error) => post({ ...command, kind: "TerminalFailed", error })),
    Effect.uninterruptible
  )
}
export const readPendingResponse = (
  command: Extract<ResponseCommand, { kind: "ReadPending" }>,
  memory: Memory["Service"],
  post: Post
) =>
  Effect.gen(function* () {
    const payload = yield* memory.pendingReply()
    const evidence = payload?.inputDeliveryId === undefined ? undefined : yield* memory.find(payload.inputDeliveryId)
    yield* post({
      kind: "PendingChecked",
      requestId: command.requestId,
      payload,
      input: evidence?.state === "Accepted" ? evidence.receipt : undefined
    })
  }).pipe(
    Effect.catch((error) => post({ kind: "RequestFailed", requestId: command.requestId, error })),
    Effect.uninterruptible
  )
