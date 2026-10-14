import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { expect } from "vitest"
import { generateKeyPair, SignJWT } from "jose"
import { subscriptionIdentityVerifier } from "../src/subscription/index.ts"
it.effect("validates signed identity issuer, audience, expiry, nonce, subject and authorized party", () =>
  Effect.gen(function* () {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair("RS256"))
    const verify = subscriptionIdentityVerifier(() => Promise.resolve(publicKey))
    const valid = {
      iss: "https://auth.openai.com",
      aud: "issued-client",
      sub: "account-subject",
      nonce: "expected-nonce",
      exp: 3600
    }
    const sign = (claims: ConstructorParameters<typeof SignJWT>[0]) =>
      Effect.promise(() => new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).sign(privateKey))
    const token = yield* sign(valid)
    expect(yield* verify(Redacted.make(token), "issued-client", "expected-nonce")).toBe("account-subject")
    for (const claims of [
      { ...valid, iss: "https://attacker.invalid" },
      { ...valid, aud: "another-client" },
      { ...valid, exp: -1 },
      { ...valid, sub: "" },
      { ...valid, nonce: "another-nonce" },
      { ...valid, aud: ["issued-client", "another-client"] },
      { ...valid, azp: "another-client" }
    ]) {
      const signed = yield* sign(claims)
      const result = yield* Effect.result(verify(Redacted.make(signed), "issued-client", "expected-nonce"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.kind).toBe("Authentication")
        expect(JSON.stringify(result.failure)).not.toContain(signed)
      }
    }
    const multi = yield* sign({ ...valid, aud: ["issued-client", "another-client"], azp: "issued-client" })
    expect(yield* verify(Redacted.make(multi), "issued-client", "expected-nonce")).toBe("account-subject")
  })
)
