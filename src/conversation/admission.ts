import { Deferred, Effect, Queue } from "effect"
import type { Scope, Semaphore } from "effect"
import { samePayload, type Memory } from "../memory/index.ts"
import { DeliveryConflict, type Message } from "./contracts.ts"
import { retainAdmissionResources, type RevocationResult } from "./admission-resources.ts"
import { makeResponses } from "./response-runtime.ts"
import type { AnswerGeneration } from "../answer-generation/index.ts"
import type { ReplySettings } from "./reply-configuration.ts"
import type { Command, AdmissionEvent } from "./admission-core/generated/core.mjs"
import type { AdmissionFailure } from "./admission-contracts.ts"
import { admissionClient, invalid, maximumToken, type Request } from "./admission-api.ts"
import * as admission from "./admission-state.ts"
import type { Entry } from "./admission-state.ts"
import { executeAdmissionStart } from "./admission-execution.ts"
import { classifyInput, persistInput } from "./admission-persistence.ts"

import {
  isOperationCompletion,
  type OperationCompletion,
  type Completion,
  type Envelope,
  type Lease,
  type Gate
} from "./admission-events.ts"

/** Conversation's mailbox is the only admission writer. Its I/O lane never owns eligibility. */
export const makeAdmissions = Effect.fn("Conversation.admissions")(function* (
  memory: Memory["Service"],
  answer: AnswerGeneration["Service"],
  settings: ReplySettings,
  scope: Scope.Scope,
  lane: Semaphore.Semaphore,
  languages: readonly string[]
) {
  const mailbox = yield* Queue.unbounded<Envelope>()
  let state = admission.emptyAdmission
  let leases: readonly Lease[] = []
  let gates: readonly Gate[] = []
  let revocationResults: readonly RevocationResult[] = []
  const revocationResult = (operation: bigint) => revocationResults.find((item) => item.operation === operation)?.result
  const leaseOf = (operation: bigint) => leases.find((lease) => lease.operation === operation)
  const commandLease = (operation: bigint) => {
    const lease = leaseOf(operation)
    if (lease === undefined) throw new Error("Admission command lost its execution resources")
    return lease
  }
  const entryOf = (operation: bigint) => state.entries.find((entry) => entry.core.operation === operation)
  const post = (event: Envelope) => Queue.offer(mailbox, event).pipe(Effect.asVoid)
  const replies = yield* makeResponses(memory, answer, settings, scope, (event) => post({ kind: "Response", event }))
  const launch = (work: Effect.Effect<void>) => work.pipe(Effect.forkIn(scope), Effect.asVoid)
  const authorized = (operation: bigint) => () => gates.some((gate) => gate.operation === operation && gate.open)
  const revoke = (operation: bigint) => {
    gates = gates.map((gate) => (gate.operation === operation ? { ...gate, open: false } : gate))
  }
  const prune = () => {
    state = admission.retireSettled(state)
    const resources = retainAdmissionResources(state, leases, gates, revocationResults)
    leases = resources.leases
    gates = resources.gates
    revocationResults = resources.results
  }
  const settleFailure = (operation: bigint, error: AdmissionFailure) => {
    const lease = leaseOf(operation)
    state = admission.markResult(state, operation, "Failed")
    prune()
    return lease === undefined ? Effect.void : Deferred.fail(lease.result, error).pipe(Effect.asVoid)
  }
  const acknowledge = (operation: bigint) => {
    const lease = leaseOf(operation)
    const receipt = entryOf(operation)?.receipt
    state = admission.markResult(state, operation, "Acknowledged")
    prune()
    return lease === undefined || receipt === undefined
      ? Effect.void
      : Deferred.succeed(lease.result, receipt).pipe(Effect.asVoid)
  }
  const lookup = (entry: Entry) => launch(classifyInput(memory, entry).pipe(Effect.flatMap(post)))
  const sendCommand = (command: Command, operation?: bigint) => {
    const lease = commandLease("operation" in command ? command.operation : (operation ?? 0n))
    return Queue.offer(lease.commands, command).pipe(Effect.asVoid)
  }
  const dispatchWork = (
    command: Extract<Command, { $: "Persist" | "RequestStart" | "StartResponse" | "RecordSuperseded" }>
  ): Effect.Effect<void> => {
    switch (command.$) {
      case "Persist": {
        const entry = admission.requireEntry(state, command.operation)
        const lease = commandLease(command.operation)
        const prerequisites = entry.prerequisites.map(revocationResult)
        return launch(
          Effect.forEach(
            prerequisites,
            (result) =>
              result === undefined
                ? Effect.die(new Error("Missing correlated revocation outcome"))
                : Deferred.await(result),
            { discard: true }
          ).pipe(
            Effect.andThen(
              persistInput(memory, replies, entry, languages).pipe(
                Effect.flatMap((result) =>
                  post({ kind: "Accepted", operation: entry.core.operation, ...result }).pipe(
                    Effect.andThen(
                      executeAdmissionStart(
                        lease.commands,
                        result.receipt,
                        replies,
                        authorized(command.operation),
                        post({
                          kind: "Core",
                          operation: command.operation,
                          event: { $: "AuthorizeStart", operation: command.operation }
                        })
                      )
                    )
                  )
                ),
                Effect.andThen(post({ kind: "Started", operation: command.operation })),
                lane.withPermits(1)
              )
            ),
            Effect.catch((error) => post({ kind: "Failed", operation: command.operation, error })),
            Effect.uninterruptible
          )
        )
      }
      case "RequestStart":
        return sendCommand(command)
      case "RecordSuperseded":
        state = admission.retainExecution(state, command)
        return sendCommand(command)
      case "StartResponse":
        state = admission.retainExecution(state, command)
        gates = [
          ...gates.filter((gate) => gate.operation !== command.operation),
          { operation: command.operation, open: true }
        ]
        return sendCommand(command)
    }
  }
  const dispatchNotice = (
    command: Exclude<Command, { $: "Persist" | "RequestStart" | "StartResponse" | "RecordSuperseded" }>
  ): Effect.Effect<void> => {
    switch (command.$) {
      case "NoCommand":
        return Effect.void
      case "AcknowledgeReceipt": {
        admission.requireAccepted(state, command.operation)
        return post({
          kind: "Core",
          operation: command.operation,
          event: { $: "PrerequisiteReady", operation: command.operation }
        })
      }
      case "RevokeStart": {
        const joinRevision = state.revocations.some(
          (item) => item.command.operation === command.operation && item.failed
        )
          ? undefined
          : state.revision
        revoke(command.operation)
        const entry = admission.requireEntry(state, command.operation)
        state = admission.retainRevocation(state, command)
        revocationResults = [
          ...revocationResults.filter((item) => item.operation !== command.operation),
          { operation: command.operation, result: Deferred.makeUnsafe<void, AdmissionFailure>() }
        ]
        return launch(
          replies.current(entry.message.deliveryId).pipe(
            Effect.flatMap((reply) => replies.interrupt(reply, "Interrupted", joinRevision)),
            lane.withPermits(1),
            Effect.andThen(post({ kind: "Revoked", operation: command.operation })),
            Effect.catch((error) =>
              error._tag === "ReplyNotFound"
                ? post({ kind: "Revoked", operation: command.operation })
                : post({ kind: "RevokeFailed", operation: command.operation, error })
            )
          )
        )
      }
      case "ReportFailure":
        return Effect.void
    }
  }
  const dispatch = (command: Command) => {
    switch (command.$) {
      case "Persist":
      case "RequestStart":
      case "StartResponse":
      case "RecordSuperseded":
        return dispatchWork(command)
      default:
        return dispatchNotice(command)
    }
  }
  const retryRevocations = (dependencies?: readonly bigint[]) =>
    Effect.forEach(
      state.revocations.filter(
        (item) => item.failed && (dependencies === undefined || dependencies.includes(item.command.operation))
      ),
      (item) => dispatch(item.command),
      { discard: true }
    )
  const transition = (entry: Entry, event: AdmissionEvent) => {
    const decision = admission.applyEvent(state, entry, event)
    state = decision.state
    return dispatch(decision.command).pipe(
      Effect.andThen(
        decision.command.$ === "NoCommand" && (event.$ === "PrerequisiteReady" || event.$ === "AuthorizeStart")
          ? sendCommand(decision.command, entry.core.operation)
          : Effect.void
      )
    )
  }
  const register = Effect.fn("Conversation.registerIntent")(function* (
    request: Extract<Request, { kind: "Register" }>
  ) {
    const { intent, result } = request
    yield* retryRevocations()
    if (intent.source !== undefined && admission.sourceOf(state, intent.source.capability) === undefined)
      return yield* Deferred.fail(result, invalid())
    const existing = state.entries.find((entry) => entry.message.deliveryId === intent.message.deliveryId)
    if (existing !== undefined) {
      if (!samePayload({ ...existing.message, role: "user" }, { ...intent.message, role: "user" }))
        return yield* Deferred.fail(
          result,
          new DeliveryConflict({ message: "Delivery identity already belongs to another payload" })
        )
      return yield* Deferred.succeed(result, { kind: "Reservation", reservation: admission.reservationOf(existing) })
    }
    const capacityFailure = admission.reservationFailure(state)
    if (capacityFailure !== undefined) return yield* Deferred.fail(result, capacityFailure)
    if (state.nextIdentity > maximumToken) return yield* Deferred.fail(result, invalid())
    const registered = admission.registerEntry(state, intent)
    state = registered.state
    const resultLease = yield* Deferred.make<Message, AdmissionFailure>()
    leases = [
      ...leases,
      { operation: registered.entry.core.operation, result: resultLease, commands: yield* Queue.unbounded<Command>() }
    ]
    yield* lookup(registered.entry)
    return yield* Deferred.succeed(result, {
      kind: "Reservation",
      reservation: admission.reservationOf(registered.entry)
    })
  })
  const fence = Effect.fn("Conversation.applySpeechFence")(function* (request: Extract<Request, { kind: "Fence" }>) {
    yield* retryRevocations()
    const source = admission.sourceOf(state, request.fence.capability)
    if (source === undefined) return yield* Deferred.fail(request.result, invalid())
    const prior = source.acknowledgements.find((ack) => ack.fenceId === request.fence.fenceId)
    if (prior !== undefined)
      return yield* prior.sequence === request.fence.sequence
        ? Deferred.succeed(request.result, { kind: "Fence", acknowledgement: { revision: prior.revision } })
        : Deferred.fail(request.result, invalid())
    if (request.fence.sequence <= source.sequence) return yield* Deferred.fail(request.result, invalid())
    if (state.revision >= maximumToken) return yield* Deferred.fail(request.result, invalid())
    const decision = admission.applyFence(state, request.fence)
    state = decision.state
    yield* Effect.forEach(decision.commands, dispatch, { discard: true })
    prune()
    return yield* Deferred.succeed(request.result, { kind: "Fence", acknowledgement: { revision: decision.revision } })
  })
  const prepareLease = Effect.fn("Conversation.prepareAdmissionWait")(function* (entry: Entry) {
    let lease = leaseOf(entry.core.operation)
    if (lease === undefined || entry.result === "Failed") {
      lease = {
        operation: entry.core.operation,
        result: yield* Deferred.make<Message, AdmissionFailure>(),
        commands: lease?.commands ?? (yield* Queue.unbounded<Command>())
      }
      leases = [...leases.filter((item) => item.operation !== entry.core.operation), lease]
    }
    return lease
  })
  const retrySettlement = (entry: Entry) => {
    if (entry.execution === undefined || entry.receipt === undefined) return Effect.void
    return launch(
      replies.recordSuperseded(entry.receipt).pipe(
        lane.withPermits(1),
        Effect.andThen(post({ kind: "Started", operation: entry.core.operation })),
        Effect.catch((error) => post({ kind: "Failed", operation: entry.core.operation, error })),
        Effect.uninterruptible
      )
    )
  }
  const retryPrerequisites = (entry: Entry) =>
    entry.result === "Failed" ? retryRevocations(entry.prerequisites) : Effect.void
  const operationRequest = Effect.fn("Conversation.inputOperation")(function* (
    request: Extract<Request, { kind: "Submit" | "Abandon" }>
  ) {
    const entry = admission.findEntry(state, request.reservation)
    if (entry === undefined) return yield* Deferred.fail(request.result, invalid())
    if (request.kind === "Abandon") {
      yield* transition(entry, { $: "AdmissionRejected", operation: entry.core.operation })
      yield* settleFailure(entry.core.operation, invalid())
      return yield* Deferred.succeed(request.result, { kind: "Done" })
    }
    const retrying = entry.result === "Failed"
    yield* retryPrerequisites(entry)
    const lease = yield* prepareLease(entry)
    const submitted = { ...entry, submitted: true, result: retrying ? ("Pending" as const) : entry.result }
    state = admission.replaceEntry(state, submitted)
    if (entry.execution !== undefined && retrying) yield* retrySettlement(submitted)
    else if (entry.classification !== "Checking")
      yield* transition(submitted, { $: "Submit", operation: entry.core.operation })
    else if (entry.core.phase.$ === "Recoverable") yield* lookup(submitted)
    return yield* Deferred.succeed(request.result, { kind: "Waiting", result: lease.result })
  })
  const exhaustedFreshRevision = (entry: Entry) => entry.source === undefined && state.revision >= maximumToken
  const classifyFresh = Effect.fn("Conversation.classifyFreshInput")(function* (entry: Entry) {
    if (exhaustedFreshRevision(entry)) {
      yield* post({ kind: "Failed", operation: entry.core.operation, error: invalid() })
      return
    }
    const decision = admission.classifyEntry(state, entry)
    state = decision.state
    yield* Effect.forEach(decision.commands, dispatch, { discard: true })
    prune()
    if (decision.entry.submitted) yield* transition(decision.entry, { $: "Submit", operation: entry.core.operation })
  })
  const classified = Effect.fn("Conversation.classifyInput")(function* (
    request: Extract<Completion, { kind: "Classified" }>
  ) {
    const entry = entryOf(request.operation)
    if (entry === undefined || entry.core.phase.$ === "Rejected") return
    if (request.evidence?.state === "Accepted") {
      const existing = { ...entry, classification: "Existing" as const }
      state = admission.replaceEntry(state, existing)
      if (existing.submitted) yield* transition(existing, { $: "Submit", operation: request.operation })
      return
    }
    yield* classifyFresh(entry)
  })

  const handleSource = (request: Extract<Request, { kind: "Open" | "Close" }>): Effect.Effect<void> => {
    const changed = admission.changeSource(state, request.kind === "Open" ? undefined : request.capability)
    if (changed === undefined) return Deferred.fail(request.result, invalid()).pipe(Effect.asVoid)
    state = changed.state
    return Deferred.succeed(request.result, changed.outcome).pipe(Effect.asVoid)
  }
  const handleRequest = (request: Request): Effect.Effect<void> => {
    switch (request.kind) {
      case "Open":
      case "Close":
        return handleSource(request)
      case "Register":
        return register(request).pipe(Effect.asVoid)
      case "Fence":
        return fence(request).pipe(Effect.asVoid)
      case "Submit":
      case "Abandon":
        return operationRequest(request).pipe(Effect.asVoid)
    }
  }
  const accepted = (request: Extract<Completion, { kind: "Accepted" }>): Effect.Effect<void> => {
    const entry = entryOf(request.operation)
    if (entry === undefined) return Effect.void
    state = admission.replaceEntry(state, { ...entry, receipt: structuredClone(request.receipt) })
    const current = entryOf(request.operation)
    return current === undefined
      ? Effect.void
      : transition(current, { $: request.existing ? "ExistingAccepted" : "Accepted", operation: request.operation })
  }
  const handleOutcome = (request: OperationCompletion): Effect.Effect<void> => {
    switch (request.kind) {
      case "Accepted":
        return accepted(request)
      case "Failed": {
        const entry = entryOf(request.operation)
        return (
          entry === undefined
            ? Effect.void
            : transition(entry, {
                $: request.error._tag === "StorageUnavailable" ? "AdmissionFailed" : "AdmissionRejected",
                operation: request.operation
              })
        ).pipe(Effect.andThen(settleFailure(request.operation, request.error)))
      }
      case "Core": {
        const entry = entryOf(request.operation)
        return entry === undefined ? Effect.void : transition(entry, request.event)
      }
    }
  }
  const handleCompletion = (request: Completion): Effect.Effect<void> => {
    if (isOperationCompletion(request)) return handleOutcome(request)
    switch (request.kind) {
      case "Revoked": {
        const result = revocationResult(request.operation)
        state = admission.settleRevocation(state, request.operation)
        prune()
        return result === undefined ? Effect.void : Deferred.succeed(result, undefined).pipe(Effect.asVoid)
      }
      case "RevokeFailed": {
        const result = revocationResult(request.operation)
        state = admission.failRevocation(state, request.operation)
        return result === undefined ? Effect.void : Deferred.fail(result, request.error).pipe(Effect.asVoid)
      }
      case "Classified":
        return classified(request)
      case "Started":
        return acknowledge(request.operation)
    }
  }
  const handle = (request: Envelope) => {
    if (request.kind === "Response") return replies.handle(request.event)
    const previousRevision = state.revision
    return ("result" in request ? handleRequest(request) : handleCompletion(request)).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          state.revision === previousRevision ? Effect.void : replies.intentAdvanced(state.revision)
        )
      )
    )
  }
  yield* Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(handle))).pipe(Effect.forkIn(scope))
  const current = (id: string) =>
    replies.current(
      id,
      state.entries.some((entry) => entry.message.deliveryId === id)
    )
  return { admissions: admissionClient(post), replies: { ...replies, current } }
})
