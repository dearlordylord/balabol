import { Effect, Layer } from "effect"
import { SqliteMemoryStorage } from "../src/memory/index.ts"
import { sqliteVoiceAdmissions } from "../src/voice/index.ts"
// Conversation's scoped SQLite layer holds its exclusive writer lease first.
export const voiceAdmissionsFixture = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = (yield* SqliteMemoryStorage).storage.database
      return sqliteVoiceAdmissions(database)
    })
  )
export const startVoiceRequest = () => ({ startRequestId: crypto.randomUUID(), muted: false })
