import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { parseConfig, serverLayer } from "../src/bootstrap/index.ts"
import { MessagePage, OlderMessagePage } from "../src/conversation/index.ts"
import { Memory, memoryLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("opens at the latest durable page and walks older history without gaps while forward sync stays unchanged", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* Memory
          for (let index = 0; index < 205; index++) {
            yield* memory.append({ deliveryId: randomUUID(), text: `message ${index}`, languageSpans: [] })
          }
        })
      ).pipe(Effect.provide(memoryLayer(fixture.path)))
    )
    const config = await Effect.runPromise(parseConfig({ BALABOL_DATABASE: fixture.path, BALABOL_PORT: "0" }))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const older = (query: string) =>
            Effect.tryPromise(() => fetch(`${address}/conversation/messages?direction=older${query}`)).pipe(
              Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
              Effect.flatMap(Schema.decodeUnknownEffect(OlderMessagePage))
            )
          const latest = yield* older("")
          expect(latest.messages.map((message) => message.text)).toEqual(
            Array.from({ length: 100 }, (_, index) => `message ${index + 105}`)
          )
          expect(latest.nextBefore).toBe(105)
          const middle = yield* older(`&before=${latest.nextBefore}`)
          expect(middle.messages.map((message) => message.position)).toEqual(
            Array.from({ length: 100 }, (_, index) => index + 5)
          )
          expect(middle.nextBefore).toBe(5)
          const first = yield* older(`&before=${middle.nextBefore}`)
          expect(first.messages.map((message) => message.position)).toEqual([0, 1, 2, 3, 4])
          expect(first.nextBefore).toBeNull()
          expect((yield* older("&before=0")).messages).toEqual([])
          const exact = yield* older("&before=100")
          expect(exact.messages).toHaveLength(100)
          expect(exact.nextBefore).toBeNull()
          const forward = yield* Effect.tryPromise(() =>
            fetch(`${address}/conversation/messages?after=200&limit=2`)
          ).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
            Effect.flatMap(Schema.decodeUnknownEffect(MessagePage))
          )
          expect(forward.messages.map((message) => message.position)).toEqual([201, 202])
          expect(forward.nextAfter).toBe(202)
          for (const query of [
            "direction=older&after=1",
            "direction=older&before=-1",
            "before=3",
            "direction=invalid",
            "direction=older&limit=101",
            "direction=older&before=NaN"
          ]) {
            const response = yield* Effect.tryPromise(() => fetch(`${address}/conversation/messages?${query}`))
            expect(response.status).toBe(400)
          }
        })
      ).pipe(Effect.provide(serverLayer(config)))
    )
  } finally {
    await fixture.close()
  }
}, 30_000)
