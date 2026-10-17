import { HashMap, Option } from "effect"
import type { PcmSlice, RecognitionState } from "./recognition-state.ts"
import { unchangedRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
const owners = (state: RecognitionState, fragmentId: string) =>
  Option.getOrElse(HashMap.get(state.fragmentOwners, fragmentId), () => 0)
export const retainFragment = (state: RecognitionState, fragmentId: string): RecognitionState => ({
  ...state,
  fragmentOwners: HashMap.set(state.fragmentOwners, fragmentId, owners(state, fragmentId) + 1)
})
const releaseFragmentOwner = (step: RecognitionTransition, fragmentId: string): RecognitionTransition => {
  const count = owners(step.state, fragmentId)
  if (count === 0) return step
  if (count > 1)
    return {
      ...step,
      state: { ...step.state, fragmentOwners: HashMap.set(step.state.fragmentOwners, fragmentId, count - 1) }
    }
  return {
    state: { ...step.state, fragmentOwners: HashMap.remove(step.state.fragmentOwners, fragmentId) },
    commands: [...step.commands, { kind: "ReleaseFragment", fragmentId }]
  }
}
/** Slice groups are ownership units. Sealing transfers a group unchanged; only a
 * boundary-split fragment gains another owner. Retirement walks that group alone. */
export const releaseSlices = (state: RecognitionState, slices: readonly PcmSlice[]): RecognitionTransition =>
  [...new Set(slices.map((slice) => slice.fragmentId))].reduce(releaseFragmentOwner, unchangedRecognition(state))
export const releaseUnownedWindow = (step: RecognitionTransition, fragmentId: string): RecognitionTransition => {
  if (HashMap.has(step.state.fragmentOwners, fragmentId)) return step
  if (step.commands.some((command) => command.kind === "ReleaseFragment" && command.fragmentId === fragmentId))
    return step
  return { state: step.state, commands: [...step.commands, { kind: "ReleaseFragment", fragmentId }] }
}
