import { createServer } from "node:http"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { Conversation, conversationRoutes } from "../conversation/index.ts"

import { welcomeRoutes } from "./welcome.ts"
import { memoryLayer } from "../memory/index.ts"

export const conversationLayer = (path: string) => Conversation.layer.pipe(Layer.provide(memoryLayer(path)))
const maximumPort = 65_535
export const ServerConfig = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maximumPort)),
  database: Schema.String.check(Schema.isMinLength(1))
})
export type ServerConfig = typeof ServerConfig.Type
export const parseConfig = (environment: NodeJS.ProcessEnv) =>
  Schema.decodeUnknownEffect(ServerConfig)({
    host: environment.BALABOL_HOST ?? "127.0.0.1",
    port: Number(environment.BALABOL_PORT ?? "8787"),
    database: environment.BALABOL_DATABASE ?? ".data/conversation.sqlite"
  })
export const serverLayer = (config: ServerConfig) =>
  HttpRouter.serve(Layer.merge(conversationRoutes, welcomeRoutes)).pipe(
    Layer.provide(conversationLayer(config.database)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: config.host, port: config.port }))
  )
export const prepareDataDirectory = (config: ServerConfig) =>
  Effect.tryPromise(() => mkdir(dirname(config.database), { recursive: true }))
