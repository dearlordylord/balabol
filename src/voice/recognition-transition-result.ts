import type { RecognitionCommand } from "./recognition-events.ts"
import type { RecognitionState } from "./recognition-state.ts"
export interface RecognitionTransition {
  readonly state: RecognitionState
  readonly commands: readonly RecognitionCommand[]
}
export const unchangedRecognition = (state: RecognitionState): RecognitionTransition => ({ state, commands: [] })
export const continueRecognition = (
  prior: RecognitionTransition,
  next: (state: RecognitionState) => RecognitionTransition
): RecognitionTransition => {
  const result = next(prior.state)
  return { state: result.state, commands: [...prior.commands, ...result.commands] }
}
