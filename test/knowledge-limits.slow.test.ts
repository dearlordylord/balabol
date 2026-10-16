import { Effect } from "effect"
import { expect, it } from "vitest"
import { PersonalKnowledge } from "../src/personal-knowledge/index.ts"
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
