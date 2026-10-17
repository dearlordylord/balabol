import { homedir } from "node:os"
import { join } from "node:path"
import { OperationAudit, auditFile, operationAuditLayer } from "../operation-audit/index.ts"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { parseConfig, prepareDataDirectory, serverLayer } from "./index.ts"

Effect.gen(function* () {
  const config = yield* parseConfig(process.env)
  yield* prepareDataDirectory(config)
  const audit = yield* OperationAudit
  return yield* Layer.launch(serverLayer(config)).pipe(Effect.withTracer(audit.tracer))
}).pipe(
  Effect.provide(
    operationAuditLayer(auditFile(join(homedir(), ".local", "share", "balabol", "diagnostics", "operations.jsonl")))
  ),
  NodeRuntime.runMain
)
