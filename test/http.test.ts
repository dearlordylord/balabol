import { Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { parseConfig, prepareDataDirectory, serverLayer } from "../src/bootstrap/index.ts"
import { ErrorResponse, Message, MessagePage } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("serves schema-validated durable POST/GET over a real HTTP socket", async () => {
  const fixture = await temporaryDatabase()
  try {
    const config = await Effect.runPromise(parseConfig({ BALABOL_DATABASE: fixture.path, BALABOL_PORT: "0" }))
    await Effect.runPromise(prepareDataDirectory(config))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const welcome = yield* Effect.tryPromise(() => fetch(`${address}/`))
          expect(welcome.status).toBe(200)
          expect(welcome.headers.get("content-type")).toContain("text/html")
          const welcomeText = yield* Effect.tryPromise(() => welcome.text())
          expect(welcomeText).toContain("Balabol backend is running")
          expect(welcomeText).toContain("ios/Balabol.xcodeproj")
          expect(welcomeText).toContain("http://127.0.0.1:8787")
          expect(welcomeText).toContain("not a browser chat")
          const payload = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "salut" }
          const post = (body: unknown) =>
            Effect.tryPromise(() =>
              fetch(`${address}/conversation/messages`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
              })
            )
          const response = yield* post(payload)
          expect(response.status).toBe(200)
          const receipt = yield* Effect.tryPromise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Message))
          )
          expect(receipt.text).toBe("salut")
          yield* Effect.tryPromise(() =>
            fetch(`${address}/conversation/replies/${payload.deliveryId}`, { method: "DELETE" })
          )
          const rootAfterMessage = yield* Effect.tryPromise(() =>
            fetch(`${address}/`, { headers: { host: "unsafe.example" } })
          )
          const rootText = yield* Effect.tryPromise(() => rootAfterMessage.text())
          expect(rootText).not.toContain(payload.text)
          expect(rootText).not.toContain("unsafe.example")
          const conflict = yield* post({ ...payload, text: "different" })
          expect(conflict.status).toBe(409)
          expect(
            (yield* Effect.tryPromise(() => conflict.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ErrorResponse))
            )).error.code
          ).toBe("DeliveryConflict")
          const invalid = yield* post({ deliveryId: "invalid", text: "" })
          expect(invalid.status).toBe(400)
          const history = yield* Effect.tryPromise(() => fetch(`${address}/conversation/messages?limit=1`))
          const page = yield* Effect.tryPromise(() => history.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(MessagePage))
          )
          expect(page.messages).toEqual([receipt])
          const badPage = yield* Effect.tryPromise(() => fetch(`${address}/conversation/messages?after=-1&limit=101`))
          expect(badPage.status).toBe(400)
          const missing = yield* Effect.tryPromise(() => fetch(`${address}/conversation/messages?after=0`))
          expect(
            (yield* Effect.tryPromise(() => missing.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(MessagePage))
            )).messages
          ).toEqual([])
        })
      ).pipe(Effect.provide(serverLayer(config)))
    )
  } finally {
    await fixture.close()
  }
})
it("rejects invalid startup configuration before resource acquisition", async () => {
  const error = await Effect.runPromise(Effect.flip(parseConfig({ BALABOL_PORT: "garbage", BALABOL_HOST: "" })))
  expect(error._tag).toBe("SchemaError")
})
