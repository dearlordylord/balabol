import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { Subscription, subscriptionLayer } from "../src/subscription/index.ts"
it("protects the saved host identity and retains registration across backend restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-subscription-"))
  const begin = Effect.gen(function* () {
    const provider = yield* Subscription
    const { authorizationUrl } = yield* provider.begin("http://127.0.0.1:12345/auth/callback")
    return new URL(authorizationUrl).searchParams.get("ext_agent_host_id")
  })
  try {
    const first = await Effect.runPromise(Effect.scoped(begin.pipe(Effect.provide(subscriptionLayer(directory)))))
    const second = await Effect.runPromise(Effect.scoped(begin.pipe(Effect.provide(subscriptionLayer(directory)))))
    expect(first).toMatch(/^urn:uuid:/u)
    expect(second).toBe(first)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, "connection.json")).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
it("refuses simultaneous credential writers and releases ownership when the first scope closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-subscription-"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Subscription
          const second = yield* Effect.result(
            Effect.scoped(Subscription.pipe(Effect.provide(subscriptionLayer(directory))))
          )
          expect(second._tag).toBe("Failure")
        }).pipe(Effect.provide(subscriptionLayer(directory)))
      )
    )
    await Effect.runPromise(Effect.scoped(Subscription.pipe(Effect.provide(subscriptionLayer(directory)))))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
it("refuses insecure directories and symlinked connection files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-subscription-"))
  const acquire = () =>
    Effect.runPromise(Effect.scoped(Subscription.pipe(Effect.provide(subscriptionLayer(directory)), Effect.result)))
  try {
    chmodSync(directory, 0o755)
    expect((await acquire())._tag).toBe("Failure")
    chmodSync(directory, 0o700)
    symlinkSync(join(directory, "missing"), join(directory, "connection.json"))
    expect((await acquire())._tag).toBe("Failure")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
it("refuses a directory masquerading as the credential file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-subscription-"))
  const wrongType = join(directory, "connection.json")
  mkdirSync(wrongType, { mode: 0o600 })
  try {
    const result = await Effect.runPromise(
      Effect.scoped(Subscription.pipe(Effect.provide(subscriptionLayer(directory)), Effect.result))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.kind).toBe("Storage")
  } finally {
    chmodSync(wrongType, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
})
