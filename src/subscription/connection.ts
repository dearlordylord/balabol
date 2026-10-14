import { Clock, Effect, Redacted, Schema, Semaphore } from "effect"
import type { SubscriptionPorts } from "./ports.ts"
import type { ConnectionStatus, Credential, PersistentState, SubscriptionFailed } from "./model.ts"
import { failed, issuer, ModelCatalog, resource, sharingScope, TokenResponse } from "./model.ts"
import { revoke } from "./revocation.ts"
import { authorizationUrl, callbackCredentials, matchedCallback, parseRedirect } from "./oauth.ts"
import type { Attempt } from "./oauth.ts"
const attemptLifetimeMillis = 600000
const refreshMarginMillis = 60000
const millisPerSecond = 1000
export const connection = (initial: PersistentState, ports: SubscriptionPorts) => {
  let state = initial
  let attempt: Attempt | undefined
  const lock = Semaphore.makeUnsafe(1)
  const save = (next: PersistentState) =>
    ports.save(next).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          state = next
        })
      )
    )
  const tokenRequest = (body: URLSearchParams) =>
    ports
      .request(`${issuer}/api/accounts/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Balabol" },
        body: body.toString()
      })
      .pipe(
        Effect.flatMap(checkResponse),
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
            Effect.mapError(() => failed("Authentication", "Invalid subscription token response"))
          )
        )
      )
  const acceptTokens = (tokens: TokenResponse, clientId: string, subject: string, previous?: Credential) =>
    Effect.gen(function* () {
      if (tokens.scope !== undefined && !tokens.scope.split(" ").includes(sharingScope))
        return yield* Effect.fail(failed("Authentication", "Subscription inference permission was not granted"))
      const refreshToken = tokens.refresh_token === undefined ? previous?.refreshToken : tokens.refresh_token
      if (refreshToken === undefined)
        return yield* Effect.fail(failed("Authentication", "Subscription sign-in did not provide a refresh token"))
      const now = yield* Clock.currentTimeMillis
      return {
        clientId,
        subject,
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt: now + tokens.expires_in * millisPerSecond,
        verified: true
      }
    })
  const active = (): Effect.Effect<Credential, SubscriptionFailed> =>
    Effect.gen(function* () {
      const current = state.credential
      if (current === undefined || !current.verified)
        return yield* Effect.fail(failed("Authentication", "Connect the ChatGPT subscription"))
      const now = yield* Clock.currentTimeMillis
      if (current.expiresAt > now + refreshMarginMillis) return current
      // Once a rotating refresh begins, finish the bounded request and persist its successor before interruption.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const tokens = yield* tokenRequest(
            new URLSearchParams({
              grant_type: "refresh_token",
              client_id: current.clientId,
              refresh_token: Redacted.value(current.refreshToken),
              resource
            })
          )
          const next = yield* acceptTokens(tokens, current.clientId, current.subject, current)
          yield* save({ ...state, credential: { ...next, verified: tokens.id_token === undefined } })
          if (tokens.id_token !== undefined) {
            const subject = yield* ports.verifyIdentity(tokens.id_token, current.clientId)
            if (subject !== current.subject)
              return yield* Effect.fail(failed("Authentication", "Subscription account changed; reconnect explicitly"))
            yield* save({ ...state, credential: next })
          }
          return next
        })
      )
    })
  const status = (): ConnectionStatus =>
    state.credential?.verified === true
      ? { kind: "Connected", expiresAt: state.credential.expiresAt }
      : { kind: "Disconnected" }
  return {
    status: () => lock.withPermit(Effect.sync(status)),
    begin: (redirectUri: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const redirect = yield* parseRedirect(redirectUri)
          const now = yield* Clock.currentTimeMillis
          const verifier = ports.random()
          const next: Attempt = {
            state: ports.random(),
            nonce: ports.random(),
            verifier,
            redirect,
            expiresAt: now + attemptLifetimeMillis,
            clientId: state.registration?.clientId ?? state.pendingClientId ?? state.credential?.clientId
          }
          attempt = next
          return { authorizationUrl: authorizationUrl(next, state.hostId) }
        })
      ),
    complete: (callbackUrl: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const pending = attempt
          if (pending === undefined) return yield* Effect.fail(failed("InvalidCallback", "No active sign-in attempt"))
          const now = yield* Clock.currentTimeMillis
          const callback = yield* matchedCallback(callbackUrl, pending, now)
          attempt = undefined
          if (callback.searchParams.has("error"))
            return yield* Effect.fail(failed("Authentication", "Subscription sign-in was declined"))
          const { clientId, code } = yield* callbackCredentials(callback, pending)
          yield* save({ ...state, pendingClientId: clientId })
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const tokens = yield* tokenRequest(
                new URLSearchParams({
                  grant_type: "authorization_code",
                  client_id: clientId,
                  code,
                  code_verifier: pending.verifier,
                  redirect_uri: pending.redirect,
                  resource
                })
              )
              if (!tokens.id_token || !tokens.scope?.split(" ").includes(sharingScope))
                return yield* Effect.fail(
                  failed("Authentication", "Subscription sign-in is missing identity or inference permission")
                )
              const subject = yield* ports.verifyIdentity(tokens.id_token, clientId, pending.nonce)
              if (state.registration !== undefined && state.registration.subject !== subject)
                return yield* Effect.fail(
                  failed(
                    "Authentication",
                    "Subscription account changed; this prototype supports the registered account only"
                  )
                )
              const credential = yield* acceptTokens(tokens, clientId, subject)
              yield* save({ ...state, registration: { clientId, subject }, credential })
              return status()
            })
          )
        })
      ),
    accessToken: () => lock.withPermit(active().pipe(Effect.map((credential) => credential.accessToken))),
    models: () =>
      lock.withPermit(
        Effect.gen(function* () {
          const credential = yield* active()
          const response = yield* ports.request(`${resource}/models`, {
            method: "GET",
            headers: { Authorization: `Bearer ${Redacted.value(credential.accessToken)}`, "User-Agent": "Balabol" }
          })
          const body = yield* checkResponse(response)
          const catalog = yield* Schema.decodeUnknownEffect(ModelCatalog)(body).pipe(
            Effect.mapError(() => failed("Provider", "Invalid subscription model catalog"))
          )
          return catalog.models
            .filter((model) => model.visibility === "list" && model.supported_in_api)
            .map((model) => model.slug)
        })
      ),
    disconnect: () =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            attempt = undefined
            const outcome = yield* revoke(state.credential, ports)
            const { credential: _credential, ...registration } = state
            yield* save(registration)
            return outcome
          })
        )
      )
  }
}
const unauthorizedStatus = 401
const forbiddenStatus = 403
const limitedStatus = 429
const minimumSuccessStatus = 200
const maximumSuccessStatus = 300
const checkResponse = (response: { readonly status: number; readonly body: unknown }) => {
  if (response.status === unauthorizedStatus || response.status === forbiddenStatus)
    return Effect.fail(failed("Authentication", "Subscription authorization is unavailable; reconnect"))
  if (response.status === limitedStatus) return Effect.fail(failed("Quota", "Subscription usage limit reached"))
  if (response.status < minimumSuccessStatus || response.status >= maximumSuccessStatus)
    return Effect.fail(failed("Provider", "Subscription provider request failed"))
  return Effect.succeed(response.body)
}
