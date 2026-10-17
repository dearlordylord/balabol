import { HashMap, Match } from "effect"
import type { RecognitionInput } from "./recognition-events.ts"
import type { RecognitionState, ReadyRecognition } from "./recognition-state.ts"
import { transitionRecognitionWindow } from "./recognition-transition-segment.ts"
import { transitionRecognitionPacket } from "./recognition-transition-packets.ts"
import { transitionRecognitionSettlement } from "./recognition-transition-settlement.ts"
import { resetRecognition, failRecognitionTurn } from "./recognition-transition-reset.ts"
import { unchangedRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
export type { RecognitionTransition } from "./recognition-transition-result.ts"
export const initialRecognition = (generation: number): RecognitionState => ({
  generation,
  segment: { kind: "Idle", slices: [], samples: 0 },
  turn: null,
  suppressed: false,
  queue: [],
  jobs: [],
  nextOperation: 1,
  fragmentOwners: HashMap.empty()
})
export const readyFinal = (state: RecognitionState): ReadyRecognition | null => state.turn?.ready ?? null
const sameReadyTurn = (state: RecognitionState, generation: number, turnId: string) =>
  state.generation === generation && state.turn?.id === turnId && state.turn.ready !== null
const dispatch = Match.type<
  RecognitionInput & { readonly state: RecognitionState; readonly allowedLanguages: readonly string[] }
>().pipe(
  Match.discriminatorsExhaustive("kind")({
    Window: (input) => transitionRecognitionWindow(input.state, input),
    JobStarted: (input) => transitionRecognitionPacket(input.state, input, input.allowedLanguages),
    Packet: (input) => transitionRecognitionPacket(input.state, input, input.allowedLanguages),
    Invalid: (input) => transitionRecognitionPacket(input.state, input, input.allowedLanguages),
    Settled: (input) => transitionRecognitionSettlement(input.state, input),
    Reset: (input) => resetRecognition(input.state, input.generation),
    Handed: (input) =>
      sameReadyTurn(input.state, input.generation, input.turnId)
        ? unchangedRecognition({ ...input.state, turn: null })
        : unchangedRecognition(input.state),
    RejectTurn: (input) =>
      sameReadyTurn(input.state, input.generation, input.turnId)
        ? failRecognitionTurn(input.state, input.error)
        : unchangedRecognition(input.state)
  })
)
export const transitionRecognition = (
  state: RecognitionState,
  event: RecognitionInput,
  allowedLanguages: readonly string[]
): RecognitionTransition => dispatch({ ...event, state, allowedLanguages })
