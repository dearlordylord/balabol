import { Schema } from "effect"
import type { InferenceFailed } from "./inference-model.ts"
const ErrorCode = Schema.Struct({ code: Schema.String })
const Failed = Schema.Struct({ response: Schema.Struct({ error: ErrorCode }) })
const JsonError = Schema.Struct({ error: ErrorCode })
const quotaCodes = new Set([
  "insufficient_quota",
  "rate_limit_exceeded",
  "usage_limit_reached",
  "quota_exceeded",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable"
])
const authenticationCodes = new Set([
  "invalid_api_key",
  "invalid_token",
  "access_denied",
  "permission_denied",
  "subscription_sharing_invalid_user",
  "subscription_sharing_user_not_eligible",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context"
])
/** Never retain upstream messages, arbitrary codes or echoed request data. */
export function providerFailure(raw: unknown, shape: "response.failed" | "error" | "json"): InferenceFailed["reason"] {
  try {
    const code =
      shape === "response.failed" ? Schema.decodeUnknownSync(Failed)(raw).response.error.code : errorCode(raw, shape)
    if (["server_error", "internal_server_error", "service_unavailable", "temporarily_unavailable"].includes(code))
      return "Unavailable"
    if (quotaCodes.has(code)) return "Quota"
    if (authenticationCodes.has(code)) return "Authentication"
    return "Failed"
  } catch {
    return "Protocol"
  }
}
function errorCode(raw: unknown, shape: "error" | "json") {
  return shape === "json"
    ? Schema.decodeUnknownSync(JsonError)(raw).error.code
    : Schema.decodeUnknownSync(ErrorCode)(raw).code
}
