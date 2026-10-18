import { VoiceFailed } from "./contracts.ts"
export type ActivityFailureReason =
  | "ProcessStart"
  | "ProcessExit"
  | "ProcessOutputLimit"
  | "ProcessProtocol"
  | "Deadline"
  | "ProviderFailure"
  | "InvalidRequest"
  | "Unavailable"
/** Native worker errors cross the Promise port only as bounded, content-free metadata. */
export const activityFailure = (reason: ActivityFailureReason) =>
  new VoiceFailed({
    code: "ActivityUnavailable",
    message: "Speech activity worker failed",
    diagnostic: { category: "Media", provider: "silero", reason }
  })
export const preserveActivityFailure = (error: unknown) =>
  error instanceof VoiceFailed ? error : activityFailure("ProviderFailure")
