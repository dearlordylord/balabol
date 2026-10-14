import { it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { Voice } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
const leaseScript = (
  joined: boolean,
  run: (fixture: ReturnType<typeof voiceTransportFixture>) => Effect.Effect<void, unknown, Voice | Conversation>
) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.promise(temporaryDatabase), (value) =>
      Effect.promise(value.close)
    )
    const fixture = voiceTransportFixture(joined)
    yield* run(fixture).pipe(Effect.provide(voiceOutputLayer(database.path, fixture)))
  })
it.effect("expires an abandoned bootstrap even while its control is polled", () =>
  leaseScript(false, (fixture) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const request = startVoiceRequest()
      const join = yield* voice.start(request)
      yield* TestClock.adjust(9000)
      expect((yield* voice.snapshot(join.sessionId, 0)).status).toBe("active")
      yield* TestClock.adjust(1100)
      expect((yield* voice.snapshot(join.sessionId, 0)).status).toBe("ended")
      expect(fixture.closed()).toBe(true)
      expect((yield* Effect.flip(voice.start(request))).code).toBe("StartExpired")
    })
  )
)
it.effect("renews a joined control lease and eventually retires media without losing Memory", () =>
  leaseScript(true, (fixture) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const join = yield* voice.start(startVoiceRequest())
      yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "Durable text" })
      yield* TestClock.adjust(20000)
      const snapshot = yield* voice.snapshot(join.sessionId, 0)
      expect(snapshot.status).toBe("active")
      expect(snapshot.controlDeadlineAt).toBeGreaterThan(join.controlDeadlineAt)
      yield* TestClock.adjust(30100)
      expect((yield* voice.snapshot(join.sessionId, 0)).status).toBe("ended")
      expect(fixture.closed()).toBe(true)
      expect((yield* conversation.page({ limit: 100 })).messages[0]?.text).toBe("Durable text")
    })
  )
)
