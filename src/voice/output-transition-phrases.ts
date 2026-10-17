import type { Phrase } from "./phrases.ts"
import type { OutputState, OutputContext, OutputSelection, OutputKey } from "./output-state.ts"
import type { OutputEvent, OutputTransition } from "./output-events.ts"
import { appendPhrases, takePhrase, phrasesEmpty } from "./phrases.ts"
import { failOutput } from "./output-transition-control.ts"
import { requestReply } from "./output-transition-publication.ts"
import {
  outputResult,
  keyedOutputOperation,
  removeOutputOperation,
  liveOutput,
  reserveOutput,
  unchangedOutput
} from "./output-transition-result.ts"
const pollMillis = 20
export const advancePhrase = (state: OutputState, phraseId: string, context: OutputContext): OutputTransition => {
  const selected = state.selected
  if (selected === null || selected.phase !== "Playing" || selected.publicationOperation === null)
    return unchangedOutput(state)
  const taken = takePhrase(selected.phrases, selected.replyComplete)
  const staged = { ...state, selected: { ...selected, phrases: taken.state } }
  if (taken.phrase === null)
    return selected.replyComplete && phrasesEmpty(taken.state) ? drain(staged) : requestReply(staged, pollMillis)
  return reservePhrase(staged, staged.selected, selected.publicationOperation, phraseId, taken.phrase, context)
}
const reservePhrase = (
  state: OutputState,
  selected: OutputSelection,
  publicationOperation: number,
  phraseId: string,
  phrase: Phrase,
  context: OutputContext
): OutputTransition => {
  if (!context.languages.includes(phrase.language))
    return failOutput(state, { code: "AudioUnavailable", message: "Unsupported reply phrase language" })
  const operation = state.nextOperation
  const reserved = reserveOutput(state, {
    kind: "Synthesis",
    operation,
    key: selected.key,
    parentOperation: publicationOperation,
    phraseId,
    phrase,
    status: "Reserved"
  })
  return outputResult(
    {
      ...reserved,
      selected: {
        ...selected,
        phraseId,
        phraseOperation: operation,
        nextPacketSequence: 0,
        phraseAudioFrames: 0,
        phraseCompleted: false
      }
    },
    [{ kind: "Synthesize", operation, key: selected.key, phraseId, phrase }]
  )
}
const drain = (state: OutputState): OutputTransition => {
  const selected = state.selected
  if (selected === null || selected.publicationOperation === null) return unchangedOutput(state)
  const operation = state.nextOperation
  const reserved = reserveOutput(state, {
    kind: "Drain",
    operation,
    key: selected.key,
    parentOperation: selected.publicationOperation,
    status: "Reserved"
  })
  return outputResult({ ...reserved, selected: { ...selected, phase: "Draining" } }, [
    { kind: "Drain", operation, key: selected.key, publicationOperation: selected.publicationOperation }
  ])
}
const replyFailure = (
  reply: Extract<OutputEvent, { kind: "ReplyObserved" }>["reply"],
  key: OutputKey
): string | null => {
  if (reply.responseId !== key.ticket.responseId || reply.inputDeliveryId !== key.ticket.inputDeliveryId)
    return "Reply identity changed during playback"
  return reply.state === "Failed" || reply.state === "Interrupted"
    ? "Reply generation stopped before audio completion"
    : null
}
const observeReply = (
  state: OutputState,
  selected: OutputSelection,
  event: Extract<OutputEvent, { kind: "ReplyObserved" }>,
  context: OutputContext
): OutputTransition => {
  const reply = event.reply
  const error = replyFailure(reply, event.key)
  if (error !== null) return failOutput(state, { code: "AudioUnavailable", message: error })
  const appended = appendPhrases(
    selected.phrases,
    reply.text,
    reply.languageSpans ?? [],
    reply.responseLanguage ?? "en"
  )
  if (appended.kind === "Rejected")
    return failOutput(state, {
      code: "AudioUnavailable",
      message: "Reply text or language annotations changed during playback"
    })
  return advancePhrase(
    {
      ...state,
      selected: {
        ...selected,
        phrases: appended.state,
        replyComplete: reply.state === "Delivering" || reply.state === "Completed"
      }
    },
    event.phraseId,
    context
  )
}
export const transitionOutputReply = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "ReplyObserved" }>,
  context: OutputContext
): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "ReplyRead") return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  const selected = liveOutput(retired, event.key)
  return selected === null || entry.status === "Cancelling"
    ? outputResult(retired)
    : observeReply(retired, selected, event, context)
}
