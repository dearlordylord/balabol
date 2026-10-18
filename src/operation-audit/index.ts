import { createHash } from "node:crypto"
import { Clock, Context, Effect, Exit, Fiber, Layer, Option, Queue, Stream, Tracer } from "effect"
import { auditRecord } from "./projection.ts"
import type { AuditStorage } from "./file.ts"
import type { AuditSpanName } from "./contracts.ts"
export { AuditSpanName } from "./contracts.ts"
export { auditFile, type AuditStorage } from "./file.ts"
const maximumPending = 512
const correlationLength = 32
const maximumRecordBytes = 16384
const flushPollMillis = 10
export const auditIdentity = (value: string) =>
  createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, correlationLength)
export class OperationAudit extends Context.Service<
  OperationAudit,
  {
    readonly tracer: Tracer.Tracer
    readonly flush: Effect.Effect<void>
    readonly health: Effect.Effect<{
      readonly pending: number
      readonly dropped: number
      readonly writeFailures: number
      readonly projectionFailures: number
      readonly reportFailures: number
    }>
    readonly parent: (identity: string) => Effect.Effect<Tracer.Span>
    readonly finish: (identity: string, exit: Exit.Exit<unknown, unknown>) => void
  }
>()("balabol/operation-audit") {}
/** Completed spans are sanitized before entering the bounded export queue. */
export const operationAuditLayer = (
  storage: AuditStorage,
  report: (message: string) => void = (message) => {
    process.stderr.write(message)
  }
) =>
  Layer.effect(
    OperationAudit,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const roots = new Map<string, Tracer.Span>()
      const queue = yield* Queue.dropping<string>(maximumPending)
      let dropped = 0
      let writeFailures = 0
      let pending = 0
      let projectionFailures = 0
      let reportFailures = 0
      const reportSafely = (message: string) => {
        try {
          report(message)
        } catch {
          reportFailures++
        }
      }
      const dropRecord = (message: string) => {
        dropped++
        if (dropped === 1) reportSafely(message)
      }
      const enqueue = (line: string) => {
        if (Buffer.byteLength(line) > maximumRecordBytes) dropRecord("Operation audit record too large\n")
        else if (Queue.offerUnsafe(queue, line)) pending++
        else dropRecord("Operation audit queue overflow\n")
      }
      const writer = yield* Effect.gen(function* () {
        while (true) {
          const line = yield* Queue.take(queue)
          yield* Effect.tryPromise({ try: () => storage.write(line), catch: () => undefined }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                writeFailures++
                if (writeFailures === 1) reportSafely("Operation audit write failed\n")
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending--
              })
            )
          )
        }
      }).pipe(Effect.forkScoped)
      const flush: Effect.Effect<void> = Effect.suspend(() =>
        pending === 0 ? Effect.void : Effect.sleep(flushPollMillis).pipe(Effect.andThen(flush))
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const span of roots.values()) span.end(clock.currentTimeNanosUnsafe(), Exit.interrupt())
          roots.clear()
        }).pipe(
          Effect.andThen(flush),
          Effect.timeoutOption("3 seconds"),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result._tag === "None")
                reportSafely(`Operation audit shutdown deadline exceeded; pending=${pending}\n`)
            })
          ),
          Effect.andThen(Fiber.interrupt(writer)),
          Effect.asVoid
        )
      )
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          const end = span.end.bind(span)
          span.end = (time, exit) => {
            if (span.status._tag === "Ended") return
            end(time, exit)
            try {
              const record = auditRecord(span, time, exit, clock.currentTimeMillisUnsafe())
              if (record === undefined) return
              const line =
                JSON.stringify({ ...record, dropped, writeFailures, projectionFailures, reportFailures }) + "\n"
              enqueue(line)
            } catch {
              projectionFailures++
              if (projectionFailures === 1) reportSafely("Operation audit projection failed\n")
            }
          }
          return span
        }
      })
      const finish = (identity: string, exit: Exit.Exit<unknown, unknown>) => {
        const span = roots.get(identity)
        if (span === undefined) return
        span.end(clock.currentTimeNanosUnsafe(), exit)
      }
      const parent = (identity: string) =>
        Effect.suspend(() => {
          const existing = roots.get(identity)
          if (existing !== undefined) return Effect.succeed(existing)
          const oldest = roots.keys().next().value
          if (roots.size >= maximumPending && oldest !== undefined) {
            finish(oldest, Exit.interrupt())
            roots.delete(oldest)
          }
          return Effect.makeSpan("conversation.response", {
            root: true,
            attributes: { response: auditIdentity(identity) }
          }).pipe(
            Effect.withTracer(tracer),
            Effect.tap((span) =>
              Effect.sync(() => {
                roots.set(identity, span)
              })
            )
          )
        })
      const health = Effect.sync(() => ({ pending, dropped, writeFailures, projectionFailures, reportFailures }))
      return { tracer, flush, health, parent, finish }
    })
  )

/** Mailbox work restores its response carrier here, outside pure state. */
export function withAuditSpan(
  name: AuditSpanName,
  responseId?: string,
  attributes: Readonly<Record<string, unknown>> = {}
) {
  return function traceResponseWork<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.gen(function* restoreResponseCarrier() {
      const audit = yield* Effect.serviceOption(OperationAudit)
      if (Option.isNone(audit)) return yield* work.pipe(Effect.withSpan(name, { attributes }))
      const parent = responseId === undefined ? undefined : yield* audit.value.parent(responseId)
      const correlated = responseId === undefined ? attributes : { ...attributes, response: auditIdentity(responseId) }
      return yield* work.pipe(
        Effect.withSpan(name, { attributes: correlated, parent }),
        Effect.withTracer(audit.value.tracer)
      )
    })
  }
}
/** Stream scope and its terminal Exit share the same audit carrier as ordinary effects. */
export function withAuditStreamSpan(
  name: AuditSpanName,
  responseId?: string,
  attributes: Readonly<Record<string, unknown>> = {}
) {
  return function traceResponseStream<A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> {
    return Stream.unwrap(
      Effect.gen(function* () {
        const audit = yield* Effect.serviceOption(OperationAudit)
        if (Option.isNone(audit)) return stream.pipe(Stream.withSpan(name, { attributes }))
        const parent = responseId === undefined ? undefined : yield* audit.value.parent(responseId)
        const correlated =
          responseId === undefined ? attributes : { ...attributes, response: auditIdentity(responseId) }
        return stream.pipe(
          Stream.withSpan(name, { attributes: correlated, parent }),
          Stream.provideService(Tracer.Tracer, audit.value.tracer)
        )
      })
    )
  }
}
export const finishAudit = (responseId: string, exit: Exit.Exit<unknown, unknown>) =>
  Effect.serviceOption(OperationAudit).pipe(
    Effect.map((audit) => {
      if (Option.isSome(audit)) audit.value.finish(responseId, exit)
    })
  )
