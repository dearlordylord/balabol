import { Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { parseConfig, serverLayer } from "../src/bootstrap/index.ts"
import { Reply } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("observes authoritative bounded SSE snapshots and durable completion over a real socket", async () => {
  const fixture = await temporaryDatabase()
  try {
    const config = await Effect.runPromise(
      parseConfig({ BALABOL_DATABASE: fixture.path, BALABOL_PORT: "0", BALABOL_FAKE_DELTA_MILLIS: "80" })
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const id = "11111111-1111-4111-8111-111111111111"
          const missing = yield* Effect.tryPromise(() => fetch(`${address}/conversation/replies/${id}`))
          expect(missing.status).toBe(404)
          const accepted = yield* Effect.tryPromise(() =>
            fetch(`${address}/conversation/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ deliveryId: id, text: "bonjour" })
            })
          )
          expect(accepted.status).toBe(200)
          const stream = yield* Effect.tryPromise(() => fetch(`${address}/conversation/replies/${id}/events`))
          expect(stream.headers.get("content-type")).toContain("text/event-stream")
          const body = yield* Effect.tryPromise(() => stream.text())
          const snapshots = body
            .trim()
            .split("\n\n")
            .map((frame) => Schema.decodeUnknownSync(Reply)(JSON.parse(frame.slice("data: ".length))))
          expect(snapshots.some((snapshot) => snapshot.state === "Streaming")).toBe(true)
          expect(snapshots.at(-1)?.state).toBe("Completed")
          let sequence = -1
          let text = ""
          for (const snapshot of snapshots) {
            expect(snapshot.inputDeliveryId).toBe(id)
            expect(snapshot.sequence).toBeGreaterThan(sequence)
            expect(snapshot.text.startsWith(text)).toBe(true)
            sequence = snapshot.sequence
            text = snapshot.text
          }
          const latest = yield* Effect.tryPromise(() => fetch(`${address}/conversation/replies/${id}`)).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
            Effect.flatMap(Schema.decodeUnknownEffect(Reply))
          )
          expect(latest).toEqual(snapshots.at(-1))
          const recovered = yield* Effect.tryPromise(() => fetch(`${address}/conversation/replies/${id}/events`))
          const final = yield* Effect.tryPromise(() => recovered.text())
          expect(final.trim().split("\n\n")).toHaveLength(1)
        })
      ).pipe(Effect.provide(serverLayer(config)))
    )
  } finally {
    await fixture.close()
  }
})
