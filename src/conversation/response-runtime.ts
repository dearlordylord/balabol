import { withAuditSpan, finishAudit } from "../operation-audit/index.ts"
import { randomUUID } from "node:crypto"
import { type Cause, Exit, Clock, Deferred, Effect, Fiber, Queue, Stream, Match, type Scope } from "effect"
import type { Receipt, Memory } from "../memory/index.ts"
import type { AnswerGeneration } from "../answer-generation/index.ts"
import {
  generateResponse,
  prepareResponseContext,
  persistResponseTerminal,
  readPendingResponse
} from "./response-work.ts"
import { transitionResponse } from "./response-transitions.ts"
import { emptyResponseState, replyProjection, ticketMatches } from "./response-state.ts"
import type { ResponseEvent, ResponseCommand, ResponseError, ResponseResult } from "./response-events.ts"
import type {
  ReplyDeliveryUpdate,
  DeliveryTicket,
  ReplyDeliveryAuthorization,
  DeliverySettlement,
  ResponseTarget,
  ResponseInvalidation
} from "./delivery.ts"
import { parseDeliveryTiming } from "./delivery.ts"
import { ReplyNotFound, type Reply, StorageUnavailable } from "./contracts.ts"
import { restoredReply, restartedReply, waitingReply } from "./reply-projection.ts"
import { responseIdentity } from "./response-identity.ts"
import type { ReplySettings } from "./reply-configuration.ts"

type RequestResource = { readonly id: string; readonly deferred: Deferred.Deferred<ResponseResult, ResponseError> }
type TicketResource = { readonly ticket: DeliveryTicket; readonly controller: AbortController }
/** All state transitions are called by the Conversation mailbox; these tables contain only executable resources. */
function* responseResources(
  memory: Memory["Service"],
  answer: AnswerGeneration["Service"],
  settings: ReplySettings,
  scope: Scope.Scope,
  post: (event: ResponseEvent) => Effect.Effect<void>
) {
  let retired = false
  let state = emptyResponseState
  let requests: readonly RequestResource[] = []
  let fibers: readonly { readonly operation: bigint; readonly fiber: Fiber.Fiber<void> }[] = []
  let subscriptions: readonly { readonly id: string; readonly queue: Queue.Queue<ReplyDeliveryUpdate, Cause.Done> }[] =
    []
  let tickets: readonly TicketResource[] = []
  const launch = (operation: bigint, work: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const owner = state.workers.find((item) => item.operation === operation)
      if (owner === undefined) return yield* Effect.die(new Error("Response command lost its immutable work owner"))
      const task = yield* work.pipe(
        Effect.ensuring(post({ kind: "WorkFinished", attempt: owner.attempt, operation })),
        Effect.interruptible,
        Effect.forkIn(scope)
      )
      fibers = [...fibers, { operation, fiber: task }]
      if (state.workers.find((item) => item.operation === operation)?.status === "Cancelling")
        yield* Fiber.interrupt(task).pipe(Effect.forkIn(scope))
    })
  const failWork = (attempt: bigint, operation: bigint) => {
    function reportWorkFailure(error: { readonly _tag: string; readonly message: string }) {
      return post({
        kind: "WorkFailed",
        attempt,
        operation,
        error: {
          code: error._tag === "StorageUnavailable" ? "StorageUnavailable" : "ProviderFailed",
          message: error.message
        }
      })
    }
    return reportWorkFailure
  }
  const settleRequest = (command: Extract<ResponseCommand, { kind: "Resolve" | "Reject" }>): Effect.Effect<void> => {
    const resource = requests.find((item) => item.id === command.requestId)
    requests = requests.filter((item) => item.id !== command.requestId)
    return resource === undefined
      ? Effect.void
      : command.kind === "Resolve"
        ? Deferred.succeed(resource.deferred, structuredClone(command.result)).pipe(Effect.asVoid)
        : Deferred.fail(resource.deferred, command.error).pipe(Effect.asVoid)
  }
  const interpret = Match.type<ResponseCommand>().pipe(
    Match.discriminatorsExhaustive("kind")({
      ReadPending: (command) => {
        return readPendingResponse(command, memory, post).pipe(Effect.forkIn(scope), Effect.asVoid)
      },
      Resolve: (command) => settleRequest(command),
      Reject: (command) => settleRequest(command),
      PrepareDelivery: (command) => {
        return launch(
          command.operation,
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            yield* post({ ...command, kind: "DeliveryPrepared", deliveryId: randomUUID(), now })
          })
        )
      },
      PrepareContext: (command) => {
        return launch(
          command.operation,
          prepareResponseContext(command, memory, settings, post).pipe(
            withAuditSpan(
              "conversation.context",
              state.current?.attempt === command.attempt ? state.current.responseId : undefined
            ),
            Effect.catch(failWork(command.attempt, command.operation))
          )
        )
      },
      Generate: (command) => {
        return launch(
          command.operation,
          generateResponse(
            command,
            answer,
            settings,
            post,
            () => state.current?.attempt === command.attempt && state.current.authorization === "Active"
          ).pipe(
            withAuditSpan("conversation.answer", command.responseId),
            Effect.catch(failWork(command.attempt, command.operation))
          )
        )
      },
      CancelWork: (command) => {
        const task = fibers.find((item) => item.operation === command.work.operation)?.fiber
        return task === undefined
          ? Effect.void
          : Fiber.interrupt(task).pipe(Effect.asVoid, Effect.forkIn(scope), Effect.asVoid)
      },
      PersistTerminal: (command) => {
        return persistResponseTerminal(command, memory, post).pipe(Effect.forkIn(scope), Effect.asVoid)
      },
      ScheduleAttachment: (command) => {
        return launch(
          command.operation,
          Effect.sleep(command.millis).pipe(Effect.andThen(post({ ...command, kind: "AttachmentExpired" })))
        )
      },
      ScheduleDeadline: (command) => {
        return launch(
          command.operation,
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => Effect.sleep(Math.max(0, command.ticket.deadlineAt - now))),
            Effect.andThen(post({ ...command, kind: "DeadlineExpired" }))
          )
        )
      },
      OpenTicket: (command) => {
        tickets = [...tickets, { ticket: command.ticket, controller: new AbortController() }]
        return Effect.void
      },
      CloseTicket: (command) => {
        for (const resource of tickets.filter((item) => ticketMatches(item.ticket, command.ticket)))
          resource.controller.abort()
        tickets = tickets.filter((item) => !ticketMatches(item.ticket, command.ticket))
        return Effect.void
      },
      PublishDelivery: (command) => {
        const queue = subscriptions.find((item) => item.id === command.update.registrationId)?.queue
        return queue === undefined
          ? Effect.void
          : Queue.offer(queue, structuredClone(command.update)).pipe(Effect.asVoid)
      },
      CloseSubscription: (command) => {
        const queue = subscriptions.find((item) => item.id === command.registrationId)?.queue
        subscriptions = subscriptions.filter((item) => item.id !== command.registrationId)
        return queue === undefined ? Effect.void : Queue.end(queue).pipe(Effect.asVoid)
      },
      ReadRetry: (command) => {
        return Effect.gen(function* () {
          const input = yield* memory.latestInput()
          const receipt = yield* memory.findReply(command.inputDeliveryId)
          const pending = yield* memory.pendingReply()
          yield* post({ ...command, kind: "RetryChecked", input, receipt, pending })
        }).pipe(
          Effect.catch((error) => post({ kind: "RequestFailed", requestId: command.requestId, error })),
          Effect.forkIn(scope),
          Effect.asVoid
        )
      },
      RecoverMemory: (command) => {
        return memory.retryFailed().pipe(
          Effect.andThen(post({ ...command, kind: "RetryRecovered" })),
          Effect.catch((error) => post({ kind: "RequestFailed", requestId: command.requestId, error })),
          Effect.forkIn(scope),
          Effect.asVoid
        )
      }
    })
  )
  const handle = (event: ResponseEvent) =>
    Effect.suspend(() => {
      const decision = transitionResponse(state, event, answer.capabilities.languages, settings.attachmentMillis)
      state = decision.state
      if (event.kind === "WorkFinished") fibers = fibers.filter((item) => item.operation !== event.operation)
      const current = state.current
      const closed = current !== undefined && (current.work.kind === "Terminal" || current.work.kind === "Failed")
      const exit =
        current === undefined || replyProjection(current).error === null
          ? Exit.succeed(undefined)
          : Exit.fail(replyProjection(current).error)
      return Effect.forEach(decision.commands, interpret, { discard: true }).pipe(
        Effect.andThen(closed ? finishAudit(current.responseId, exit) : Effect.void)
      )
    })
  const request = (event: (requestId: string) => ResponseEvent) =>
    Effect.gen(function* () {
      if (retired) return yield* new StorageUnavailable({ message: "Conversation resources have retired" })
      const id = randomUUID()
      const deferred = yield* Deferred.make<ResponseResult, ResponseError>()
      requests = [...requests, { id, deferred }]
      yield* post(event(id))
      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            requests = requests.filter((item) => item.id !== id)
          })
        )
      )
    })
  const missingLocal = (id: string, pending: boolean) =>
    Effect.gen(function* () {
      const input = yield* memory.find(id)
      if (input?.state !== "Accepted" || input.receipt.role === "assistant")
        return yield* new ReplyNotFound({ message: "Unknown accepted input" })
      return pending
        ? waitingReply(input.receipt, responseIdentity(id), answer.capabilities.languages).state
        : restartedReply(input.receipt)
    })
  const current = (id: string, pending = false): Effect.Effect<Reply, ReplyNotFound | StorageUnavailable> =>
    Effect.gen(function* () {
      const local = state.current?.input.deliveryId === id ? structuredClone(replyProjection(state.current)) : undefined
      if (local !== undefined && local.state !== "Failed") return local
      const receipt = yield* memory.findReply(id)
      if (receipt !== undefined) return restoredReply(receipt, id)
      if (local !== undefined) return local
      return yield* missingLocal(id, pending)
    })
  const storageOnly = <A>(work: Effect.Effect<A, ResponseError>) =>
    work.pipe(Effect.catch((error) => (error._tag === "StorageUnavailable" ? Effect.fail(error) : Effect.die(error))))
  const infallible = <A>(work: Effect.Effect<A, ResponseError>) => work.pipe(Effect.orDie)
  const voidRequest = (event: (id: string) => ResponseEvent) => request(event).pipe(Effect.asVoid)
  const replyRequest = (event: (id: string) => ResponseEvent) =>
    request(event).pipe(Effect.map((result) => (result.kind === "Reply" ? result.reply : null)))
  const authorization = (ticket: DeliveryTicket): ReplyDeliveryAuthorization => {
    const resource = tickets.find((item) => ticketMatches(item.ticket, ticket))
    if (resource === undefined) return { isAuthorized: () => false, signal: AbortSignal.abort() }
    return {
      signal: resource.controller.signal,
      isAuthorized: () =>
        !resource.controller.signal.aborted &&
        tickets.includes(resource) &&
        state.registration?.registrationId === ticket.registrationId &&
        state.current?.authorization === "Active" &&
        ticketMatches(state.current.ticket, ticket)
    }
  }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      retired = true
      const closing = requests
      requests = []
      yield* Effect.forEach(
        closing,
        (item) =>
          Deferred.fail(
            item.deferred,
            new StorageUnavailable({ message: "Conversation resources retired before request completed" })
          ),
        { discard: true }
      )
      for (const resource of tickets) resource.controller.abort()
      tickets = []
      yield* Effect.forEach(subscriptions, (item) => Queue.shutdown(item.queue), { discard: true })
      subscriptions = []
    })
  )
  return {
    handle,
    intentAdvanced: (revision: bigint) => handle({ kind: "IntentAdvanced", revision }),
    start: (input: Receipt, retry = false, authorized: () => boolean = () => true, issuedRevision = state.revision) =>
      storageOnly(
        voidRequest((id) => ({
          kind: "Start",
          requestId: id,
          input,
          responseId: retry ? randomUUID() : responseIdentity(input.deliveryId),
          issuedRevision,
          granted: authorized(),
          superseded: false
        }))
      ),
    recordSuperseded: (input: Receipt) =>
      memory
        .findReply(input.deliveryId)
        .pipe(
          Effect.flatMap((existing) =>
            existing === undefined
              ? storageOnly(
                  voidRequest((id) => ({
                    kind: "Start",
                    requestId: id,
                    input,
                    responseId: responseIdentity(input.deliveryId),
                    issuedRevision: state.revision,
                    granted: false,
                    superseded: true
                  }))
                )
              : Effect.void
          )
        ),
    admit: (reason: ResponseInvalidation["reason"] = "Interrupted", joinRevision?: bigint) =>
      storageOnly(
        voidRequest((id) => ({
          kind: "Admit",
          requestId: id,
          reason,
          ...(joinRevision === undefined ? {} : { joinRevision })
        }))
      ),
    current,
    interrupt: (
      target: ResponseTarget,
      reason: ResponseInvalidation["reason"] = "Interrupted",
      joinRevision?: bigint
    ) =>
      storageOnly(
        replyRequest((id) => ({
          kind: "Interrupt",
          requestId: id,
          target,
          reason,
          ...(joinRevision === undefined ? {} : { joinRevision })
        }))
      ),
    settle: (settlement: DeliverySettlement) =>
      storageOnly(replyRequest((id) => ({ kind: "Settle", requestId: id, settlement }))),
    observe: (inputDeliveryId: string) =>
      current(inputDeliveryId).pipe(
        Effect.andThen(
          infallible(request((id) => ({ kind: "Observe", requestId: id, inputDeliveryId, token: randomUUID() })))
        ),
        Effect.map((result) => (result.kind === "Observer" ? result.token : ""))
      ),
    release: (inputDeliveryId: string, token: string) =>
      infallible(voidRequest((id) => ({ kind: "Release", requestId: id, inputDeliveryId, token }))),
    cancel: (inputDeliveryId: string) =>
      infallible(voidRequest((id) => ({ kind: "Cancel", requestId: id, inputDeliveryId }))),
    retry: (inputDeliveryId: string) =>
      request((id) => ({ kind: "Retry", requestId: id, inputDeliveryId, responseId: randomUUID() })).pipe(
        Effect.andThen(current(inputDeliveryId))
      ),
    register: (input: { readonly completionMillis: number }) =>
      Effect.gen(function* () {
        yield* parseDeliveryTiming(input.completionMillis)
        const registrationId = randomUUID()
        const queue = yield* Queue.sliding<ReplyDeliveryUpdate, Cause.Done>(1)
        subscriptions = [...subscriptions, { id: registrationId, queue }]
        const registered = yield* request((id) => ({
          kind: "Register",
          requestId: id,
          registrationId,
          completionMillis: input.completionMillis
        })).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              subscriptions = subscriptions.filter((item) => item.id !== registrationId)
              yield* Queue.shutdown(queue)
            })
          ),
          Effect.onInterrupt(() =>
            voidRequest((id) => ({ kind: "Detach", requestId: id, registrationId })).pipe(Effect.ignore)
          )
        )
        if (registered.kind !== "Registered")
          return yield* Effect.die(new Error("Missing registration acknowledgement"))
        return {
          registrationId,
          snapshot: registered.snapshot,
          updates: Stream.fromQueue(queue).pipe(
            Stream.ensuring(
              voidRequest((id) => ({ kind: "Detach", requestId: id, registrationId })).pipe(Effect.ignore)
            )
          )
        }
      }).pipe(
        Effect.catch((error) =>
          error._tag === "InvalidInput" || error._tag === "ReplyBusy" ? Effect.fail(error) : Effect.die(error)
        )
      ),
    unregister: (registrationId: string) =>
      storageOnly(voidRequest((id) => ({ kind: "Detach", requestId: id, registrationId }))),
    authorization,
    snapshot: (registrationId: string) =>
      Effect.sync(() =>
        state.current?.ticket?.registrationId === registrationId && authorization(state.current.ticket).isAuthorized()
          ? structuredClone(state.current.ticket)
          : null
      )
  }
}
export const makeResponses = Effect.fn("Conversation.responseResources")(responseResources)
export type Responses = Effect.Success<ReturnType<typeof makeResponses>>
