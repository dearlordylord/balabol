import { Schema } from "effect"
import type { Receipt } from "../memory/index.ts"
import { Reply } from "./contracts.ts"
import { responseIdentity } from "./response-identity.ts"
import { selectResponseLanguage } from "./response-language.ts"

export type ResponseBase = {
  readonly responseId: string
  readonly inputDeliveryId: string
  readonly responseLanguage: string
}
export const maximumReplyLength = 100_000
export const languageField = (language: string | null | undefined) =>
  language == null ? {} : { responseLanguage: language }

export const waitingReply = (input: Receipt, responseId: string, languages: readonly string[]) => {
  const base: ResponseBase = {
    responseId,
    inputDeliveryId: input.deliveryId,
    responseLanguage:
      input.responseLanguage ?? selectResponseLanguage(input.languageSpans, input.detectedLanguage, languages)
  }
  const state: Reply = {
    ...base,
    sequence: 0,
    state: "Waiting",
    languageSpans: [],
    text: "",
    error: null,
    receipt: null
  }
  return { base, state }
}

export const restoredReply = (receipt: Receipt, inputDeliveryId: string): Reply =>
  Schema.decodeUnknownSync(Reply)({
    ...languageField(receipt.responseLanguage),
    responseId: receipt.deliveryId,
    inputDeliveryId,
    sequence: maximumReplyLength + 1,
    state: receipt.outcome === "interrupted" ? "Interrupted" : "Completed",
    text: receipt.text,
    languageSpans: receipt.languageSpans,
    error: null,
    receipt
  })

export const restartedReply = (input: Receipt): Reply => ({
  ...languageField(input.responseLanguage),
  responseId: responseIdentity(input.deliveryId),
  inputDeliveryId: input.deliveryId,
  sequence: 0,
  state: "Failed",
  languageSpans: [],
  text: "",
  error: { code: "Restarted", message: "Reply state was lost at backend restart; retry the accepted input" },
  receipt: null
})
