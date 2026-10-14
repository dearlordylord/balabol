import { createHash, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import { failed, issuer, resource, sharingScope } from "./model.ts"
const maximumCallbackLength = 131072
const maximumCodeLength = 32768
const maximumClientLength = 32768
export interface Attempt {
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  readonly redirect: string
  readonly expiresAt: number
  readonly clientId: string | undefined
}
const parseUrl = (raw: string) =>
  Effect.try({
    try: () => {
      if (raw.length > maximumCallbackLength) throw new Error("Oversized URL")
      return new URL(raw)
    },
    catch: () => failed("InvalidCallback", "Invalid sign-in callback")
  })
export const parseRedirect = (raw: string) =>
  parseUrl(raw).pipe(
    Effect.flatMap((url) => {
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return Effect.fail(failed("InvalidCallback", "Sign-in requires a loopback HTTP callback"))
      return Effect.succeed(url.href)
    })
  )
export const authorizationUrl = (attempt: Attempt, hostId: string) => {
  const params = new URLSearchParams({
    client_id: attempt.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: attempt.redirect,
    scope: `openid profile email offline_access resource.invoke ${sharingScope}`,
    resource,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url")
  })
  if (attempt.clientId === undefined) params.set("agent_name_hint", "Balabol")
  return `${issuer}/api/accounts/authorize?${params.toString()}`
}
const equalState = (actual: string | null, expected: string) => {
  if (actual === null || actual.length !== expected.length) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
export const matchedCallback = (raw: string, attempt: Attempt, now: number) =>
  parseUrl(raw).pipe(
    Effect.flatMap((url) => {
      if (["state", "code", "client_id", "error"].some((key) => url.searchParams.getAll(key).length > 1))
        return Effect.fail(failed("InvalidCallback", "Ambiguous sign-in callback parameters"))
      const valid =
        `${url.origin}${url.pathname}` === attempt.redirect &&
        equalState(url.searchParams.get("state"), attempt.state) &&
        now < attempt.expiresAt
      if (!valid) return Effect.fail(failed("InvalidCallback", "Sign-in callback does not match an active attempt"))
      return Effect.succeed(url)
    })
  )
const matchingClient = (expected: string | undefined, returned: string | null) =>
  expected === undefined || returned === null || returned === expected
export const callbackCredentials = (callback: URL, attempt: Attempt) => {
  const code = callback.searchParams.get("code")
  const returned = callback.searchParams.get("client_id")
  const clientId = attempt.clientId ?? returned
  if (
    !code ||
    code.length > maximumCodeLength ||
    !clientId ||
    clientId.length > maximumClientLength ||
    clientId === "dynamic_agent_client"
  )
    return Effect.fail(failed("InvalidCallback", "Sign-in callback is missing its issued client or code"))
  if (!matchingClient(attempt.clientId, returned))
    return Effect.fail(failed("InvalidCallback", "Sign-in returned a different registered client"))
  return Effect.succeed({ code, clientId })
}
