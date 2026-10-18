import { Effect } from "effect"
import { expect, it } from "vitest"
import { PersonalKnowledge, knowledgeLimits } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { context, entities, creation, declaration, opened } from "./knowledge-limits-fixture.ts"

it("accepts ten thousand small entities and rejects entity 10001 while retaining accepted history", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(declaration, context("declare"))
        for (let batch = 0; batch < 100; batch++)
          yield* knowledge.apply(creation(entities(batch * 100, 100, 0)), context(`batch${batch}`))
        expect((yield* knowledge.revision(101)).entities).toHaveLength(10_000)
        expect(
          yield* knowledge.apply(creation(entities(10_000, 1, 0)), context("excess-entity")).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "LimitExceeded" } })
        expect((yield* knowledge.inspect()).revision).toBe(101)
        expect((yield* knowledge.revision(2)).entities).toEqual(entities(0, 100, 0))
      })
    )
  } finally {
    await database.close()
  }
}, 30_000)

it("retains SQLite history while reaching the four-MiB state byte limit", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(declaration, context("declare"))
        for (let batch = 0; batch < 3; batch++)
          yield* knowledge.apply(creation(entities(batch * 25, 25, 4096)), context(`batch${batch}`))
        expect(yield* knowledge.query({ limit: 100 }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "LimitExceeded", message: expect.stringContaining("262144") }
        })
        expect((yield* knowledge.query({ limit: 25 })).entities).toHaveLength(25)
        let accepted = 4
        let stateLimitReached = false
        for (let batch = 3; batch < 45; batch++) {
          const result = yield* knowledge
            .apply(creation(entities(batch * 25, 25, 4096)), context(`batch${batch}`))
            .pipe(Effect.result)
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({ code: "LimitExceeded", message: expect.stringContaining("4194304") })
            stateLimitReached = true
            break
          }
          accepted = result.success.revision
        }
        expect(stateLimitReached).toBe(true)
        expect((yield* knowledge.inspect()).revision).toBe(accepted)
        expect((yield* knowledge.revision(2)).entities).toEqual(entities(0, 25, 4096))
        expect(Buffer.byteLength(JSON.stringify(yield* knowledge.revision(accepted)))).toBeLessThanOrEqual(
          knowledgeLimits.stateBytes
        )
      })
    )
  } finally {
    await database.close()
  }
}, 60_000)
