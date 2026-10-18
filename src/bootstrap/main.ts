import { homedir } from "node:os"
import { join } from "node:path"
import { OperationAudit, auditFile, operationAuditLayer, withAuditSpan } from "../operation-audit/index.ts"
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Layer } from "effect"
import { parseConfig, prepareDataDirectory, serverLayer } from "./index.ts"

Effect.gen(function* () {
  const audit = yield* OperationAudit
  const config = yield* Effect.gen(function* () {
    const parsed = yield* parseConfig(process.env)
    yield* prepareDataDirectory(parsed)
    return parsed
  }).pipe(withAuditSpan("backend.configure"), reportFailure("configuration"))
  return yield* Layer.launch(serverLayer(config)).pipe(
    withAuditSpan("backend.runtime"),
    Effect.withTracer(audit.tracer),
    reportFailure("runtime")
  )
}).pipe(
  Effect.provide(
    operationAuditLayer(auditFile(join(homedir(), ".local", "share", "balabol", "diagnostics", "operations.jsonl")))
  ),
  NodeRuntime.runMain({ disableErrorReporting: true })
)

function reportFailure(stage: "configuration" | "runtime") {
  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => {
              process.stderr.write(`Balabol backend ${stage} failed\n`)
            })
      )
    )
}
