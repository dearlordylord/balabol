import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { HttpServer, HttpRouter } from "effect/http"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { Reply, CurrentTurn, conversationRoutes } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("observes authoritative bounded SSE snapshots and durable completion over a real socket", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Deferred.make<void>()
          const provider = Layer.succeed(AnswerGeneration, {
            capabilities: { languages: ["en"], output: "text-deltas" },
            generate: () =>
              Stream.concat(
                Stream.succeed({
                  kind: "Delta",
                  text: "fixture reply",
                  languageSpans: [{ language: "en", start: 0, end: 13 }]
                }),
                Stream.fromEffect(Deferred.await(completion).pipe(Effect.as({ kind: "Completed" as const })))
              )
          })
          const server = HttpRouter.serve(conversationRoutes).pipe(
            Layer.provide(replyLayer(fixture.path, provider)),
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
          )
          yield* Effect.gen(function* () {
            const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
            const id = "11111111-1111-4111-8111-111111111111"
            const empty = yield* Effect.tryPromise(() =>
              fetch(`${address}/conversation/current`).then((response) => response.json())
            )
            expect(empty).toBeNull()
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
            const reader = stream.body?.getReader()
            if (reader === undefined) throw new Error("SSE response lacks a readable body")
            const decoder = new TextDecoder()
            let body = ""
            let released = false
            while (true) {
              const chunk = yield* Effect.tryPromise(() => reader.read())
              if (chunk.done) break
              body += decoder.decode(chunk.value, { stream: true })
              const frames = body.split("\n\n").slice(0, -1)
              const observedStreaming = frames.some(
                (frame) =>
                  Schema.decodeUnknownSync(Reply)(JSON.parse(frame.slice("data: ".length))).state === "Streaming"
              )
              if (!released && observedStreaming) {
                released = true
                yield* Deferred.succeed(completion, undefined)
              }
            }
            body += decoder.decode()
            expect(released).toBe(true)
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
            const current = yield* Effect.tryPromise(() =>
              fetch(`${address}/conversation/current`).then((response) => response.json())
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CurrentTurn)))
            expect(current?.input.deliveryId).toBe(id)
            expect(current?.reply).toEqual(latest)
            const retried = yield* Effect.tryPromise(() =>
              fetch(`${address}/conversation/replies/${id}/retry`, { method: "POST" }).then((response) =>
                response.json()
              )
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Reply)))
            expect(retried).toEqual(latest)
            const recovered = yield* Effect.tryPromise(() => fetch(`${address}/conversation/replies/${id}/events`))
            const final = yield* Effect.tryPromise(() => recovered.text())
            expect(final.trim().split("\n\n")).toHaveLength(1)
          }).pipe(Effect.provide(server))
        })
      )
    )
  } finally {
    await fixture.close()
  }
})
