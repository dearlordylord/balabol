import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { parseConfig, prepareDataDirectory, serverLayer } from "./index.ts"

Effect.gen(function* () {
  const config = yield* parseConfig(process.env)
  yield* prepareDataDirectory(config)
  return yield* Layer.launch(serverLayer(config))
}).pipe(NodeRuntime.runMain)
