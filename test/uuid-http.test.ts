import { Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { parseConfig, serverLayer } from "../src/bootstrap/index.ts"
import { Message, Reply } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("uses one canonical UUID for socket replay, reply observation and cancellation", async () => {
  const fixture = await temporaryDatabase()
  const first = "abcdefab-cdef-4abc-8def-abcdefabcdef"
  const second = "fedcbafe-dcba-4fed-8cba-fedcbafedcba"
  try {
    const config = await Effect.runPromise(
      parseConfig({ BALABOL_DATABASE: fixture.path, BALABOL_PORT: "0", BALABOL_FAKE_DELTA_MILLIS: "1000" })
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const send = (deliveryId: string, text: string) =>
            Effect.tryPromise(() =>
              fetch(`${address}/conversation/messages`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ deliveryId, text })
              })
            ).pipe(
              Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
              Effect.flatMap(Schema.decodeUnknownEffect(Message))
            )
          const accepted = yield* send(first.toUpperCase(), "Case preserved")
          yield* send(second.toUpperCase(), "newer")
          expect(yield* send(first, "Case preserved")).toEqual(accepted)
          const interrupted = yield* Effect.tryPromise(() =>
            fetch(`${address}/conversation/replies/${first.toUpperCase()}`)
          ).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
            Effect.flatMap(Schema.decodeUnknownEffect(Reply))
          )
          expect(interrupted.state).toBe("Interrupted")
          expect(interrupted.inputDeliveryId).toBe(first)
          const frames = yield* Effect.tryPromise(() =>
            fetch(`${address}/conversation/replies/${first.toUpperCase()}/events`)
          ).pipe(Effect.flatMap((response) => Effect.tryPromise(() => response.text())))
          expect(Schema.decodeUnknownSync(Reply)(JSON.parse(frames.trim().slice("data: ".length))).state).toBe(
            "Interrupted"
          )
          const cancelled = yield* Effect.tryPromise(() =>
            fetch(`${address}/conversation/replies/${second.toUpperCase()}`, { method: "DELETE" })
          )
          expect(cancelled.status).toBe(204)
          const failed = yield* Effect.tryPromise(() => fetch(`${address}/conversation/replies/${second}`)).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
            Effect.flatMap(Schema.decodeUnknownEffect(Reply))
          )
          expect(failed.error?.code).toBe("Cancelled")
        })
      ).pipe(Effect.provide(serverLayer(config)))
    )
  } finally {
    await fixture.close()
  }
})
