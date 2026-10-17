import type { LanguageSpan } from "../language/index.ts"
import type { RecognitionState, RecognitionTurn, ReadyRecognition } from "./recognition-state.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
interface Assembly {
  readonly text: string
  readonly spans: readonly LanguageSpan[]
  readonly languages: readonly (string | null)[]
}
const assemble = (turn: RecognitionTurn): ReadyRecognition => {
  const ordered = turn.results.toSorted((left, right) => left.index - right.index)
  const result = ordered.reduce<Assembly>(
    (prior, { final }) => {
      if (final.text.trim().length === 0) return prior
      const separator = prior.text.length === 0 ? "" : " "
      const offset = prior.text.length + separator.length
      return {
        text: prior.text + separator + final.text,
        spans: [
          ...prior.spans,
          ...final.spans.map((span) => ({ ...span, start: span.start + offset, end: span.end + offset }))
        ],
        languages: [...prior.languages, final.detectedLanguage ?? null, ...final.spans.map((span) => span.language)]
      }
    },
    { text: "", spans: [], languages: [] }
  )
  const languages = [...new Set(result.languages)]
  return {
    turnId: turn.id,
    generation: turn.generation,
    fenceId: turn.fenceId,
    text: result.text,
    languageSpans: result.spans,
    detectedLanguage: languages.length === 1 ? (languages[0] ?? null) : null
  }
}
export const prepareRecognitionFinal = (state: RecognitionState): RecognitionTransition => {
  const turn = state.turn
  if (turn === null || !turn.ended || turn.results.length !== turn.chunks || turn.ready !== null)
    return { state, commands: [] }
  const ready = assemble(turn)
  return ready.text.trim().length === 0
    ? {
        state: { ...state, turn: null },
        commands: [{ kind: "Discarded", turnId: turn.id, generation: turn.generation }]
      }
    : { state: { ...state, turn: { ...turn, ready } }, commands: [] }
}
