import { createHash } from "node:crypto"
import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { Clock, Context, Effect, Exit, Fiber, Layer, Option, Queue, Tracer } from "effect"
import { auditRecord } from "./projection.ts"
const maximumBytes = 4194304
const maximumPending = 512
const correlationLength = 32
const privateFileMode = 0o600
const flushPollMillis = 10
export const auditIdentity = (value: string) =>
  createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, correlationLength)
export interface AuditStorage {
  readonly write: (line: string) => Promise<void>
}
export const auditFile = (path: string): AuditStorage => ({
  async write(line) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const size = await stat(path).then(
      (file) => file.size,
      () => 0
    )
    if (size + Buffer.byteLength(line) > maximumBytes) await rename(path, `${path}.previous`)
    await appendFile(path, line, { mode: privateFileMode })
    await chmod(path, privateFileMode)
  }
})
export class OperationAudit extends Context.Service<
  OperationAudit,
  {
    readonly tracer: Tracer.Tracer
    readonly flush: Effect.Effect<void>
    readonly parent: (identity: string) => Effect.Effect<Tracer.Span>
    readonly finish: (identity: string, exit: Exit.Exit<unknown, unknown>) => void
  }
>()("balabol/operation-audit") {}
/** Completed spans are sanitized before entering the bounded export queue. */
export const operationAuditLayer = (storage: AuditStorage) =>
  Layer.effect(
    OperationAudit,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const roots = new Map<string, Tracer.Span>()
      const queue = yield* Queue.dropping<string>(maximumPending)
      let dropped = 0
      let writeFailures = 0
      let pending = 0
      const writer = yield* Effect.gen(function* () {
        while (true) {
          const line = yield* Queue.take(queue)
          yield* Effect.tryPromise({ try: () => storage.write(line), catch: () => undefined }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                writeFailures++
                process.stderr.write("Operation audit write failed\n")
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
                process.stderr.write(`Operation audit shutdown deadline exceeded; pending=${pending}\n`)
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
            const record = auditRecord(span, time, exit, clock.currentTimeMillisUnsafe())
            if (record === undefined) return
            if (Queue.offerUnsafe(queue, JSON.stringify({ ...record, dropped, writeFailures }) + "\n")) pending++
            else {
              dropped++
              process.stderr.write("Operation audit queue overflow\n")
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
      return { tracer, flush, parent, finish }
    })
  )

/** Mailbox work restores its response carrier here, outside pure state. */
export function withAuditSpan(name: string, responseId?: string) {
  return function traceResponseWork<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.gen(function* restoreResponseCarrier() {
      const audit = yield* Effect.serviceOption(OperationAudit)
      if (Option.isNone(audit) || responseId === undefined) return yield* work.pipe(Effect.withSpan(name))
      const parent = yield* audit.value.parent(responseId)
      return yield* work.pipe(
        Effect.withSpan(name, { attributes: { response: auditIdentity(responseId) } }),
        Effect.withParentSpan(parent)
      )
    })
  }
}
export const finishAudit = (responseId: string, exit: Exit.Exit<unknown, unknown>) =>
  Effect.serviceOption(OperationAudit).pipe(
    Effect.map((audit) => {
      if (Option.isSome(audit)) audit.value.finish(responseId, exit)
    })
  )
