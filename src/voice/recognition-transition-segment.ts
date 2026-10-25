import { maximumRecognitionChunks } from "./recognition-state.ts"
import { feedStreamingRecognition, sealStreamingRecognition } from "./recognition-transition-streaming.ts"
import { prepareRecognitionFinal } from "./recognition-transition-assembly.ts"
import type { RecognitionInput } from "./recognition-events.ts"
import type { PcmSlice, RecognitionState, RecognitionTurn } from "./recognition-state.ts"
import { retainFragment, releaseSlices, releaseUnownedWindow } from "./recognition-transition-fragments.ts"
import { failRecognitionTurn } from "./recognition-transition-reset.ts"
import { pumpRecognition } from "./recognition-transition-jobs.ts"
import { continueRecognition, unchangedRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
export const recognitionOnsetSamples = 960
export const recognitionQuietSamples = 16000
export const recognitionChunkSamples = 160000
const lastSliceOffset = -1
type Window = Extract<RecognitionInput, { kind: "Window" }>
interface Piece {
  readonly step: RecognitionTransition
  readonly offset: number
}
const appendSlice = (state: RecognitionState, slice: PcmSlice): RecognitionState => {
  const owned = state.segment.slices.at(lastSliceOffset)?.fragmentId === slice.fragmentId
  return owned ? state : retainFragment(state, slice.fragmentId)
}
/** Only a qualified onset extends a ready turn; subthreshold PCM remains an
 * onset candidate and can carry into the next turn if the prior one is handed. */
const onset = (state: RecognitionState, event: Window): RecognitionTransition => {
  if (state.turn !== null && state.turn.generation !== event.generation) {
    const released = releaseSlices(state, state.segment.slices)
    return {
      state: { ...released.state, suppressed: true, segment: { kind: "Active", slices: [], samples: 0, quiet: 0 } },
      commands: [
        ...released.commands,
        {
          kind: "Error",
          turnId: event.turnId,
          generation: event.generation,
          error: {
            code: "RecognitionFailed",
            message: "Previous captured speech is still processing; repeat this utterance after it finishes"
          }
        }
      ]
    }
  }
  if (state.turn !== null) return unchangedRecognition({ ...state, turn: { ...state.turn, ended: false, ready: null } })
  const turn: RecognitionTurn = {
    id: event.turnId,
    generation: event.generation,
    fenceId: event.fenceId,
    ended: false,
    chunks: 0,
    results: [],
    textLength: 0,
    spanCount: 0,
    ready: null
  }
  return {
    state: { ...state, turn },
    commands: [{ kind: "Onset", turnId: turn.id, generation: turn.generation, fenceId: turn.fenceId }]
  }
}
const collectOnset = (state: RecognitionState, event: Window, offset: number): Piece => {
  const slice: PcmSlice = {
    fragmentId: event.fragmentId,
    offsetSamples: offset,
    sampleFrames: event.sampleFrames - offset
  }
  const owned = appendSlice(state, slice)
  const slices = [...state.segment.slices, slice]
  const samples = state.segment.samples + slice.sampleFrames
  const next: RecognitionState = {
    ...owned,
    segment:
      samples < recognitionOnsetSamples
        ? { kind: "Idle", slices, samples }
        : { kind: "Active", slices, samples, quiet: 0 }
  }
  return {
    step:
      samples < recognitionOnsetSamples
        ? unchangedRecognition(next)
        : continueRecognition(onset(next, event), (current) =>
            feedStreamingRecognition(current, event.requestId, slices)
          ),
    offset: event.sampleFrames
  }
}
const idlePiece = (state: RecognitionState, event: Window, offset: number): Piece => {
  if (event.speech) return collectOnset(state, event, offset)
  const released = releaseSlices(state, state.segment.slices)
  return {
    step: {
      state: { ...released.state, segment: { kind: "Idle", slices: [], samples: 0 } },
      commands: released.commands
    },
    offset: event.sampleFrames
  }
}
const seal = (state: RecognitionState, requestId: string, ended: boolean): RecognitionTransition => {
  const turn = state.turn
  const segment = state.segment
  if (turn === null || segment.kind !== "Active") return unchangedRecognition(state)
  if (state.streaming) return sealStreamingRecognition(state, ended)
  const next = { ...state, turn: { ...turn, ended } }
  if (turn.chunks >= maximumRecognitionChunks)
    return failRecognitionTurn(next, {
      code: "RecognitionFailed",
      message: "Spoken turn exceeds recognition chunk capacity",
      reason: "Other"
    })
  const chunk = {
    turnId: turn.id,
    generation: turn.generation,
    index: turn.chunks,
    requestId,
    slices: segment.slices,
    sampleFrames: segment.samples
  }
  return pumpRecognition({
    ...next,
    turn: { ...turn, ended, chunks: turn.chunks + 1, ready: null },
    queue: [...state.queue, chunk],
    segment: ended
      ? { kind: "Idle", slices: [], samples: 0 }
      : { kind: "Active", slices: [], samples: 0, quiet: segment.quiet }
  })
}
const activePiece = (state: RecognitionState, event: Window, offset: number): Piece => {
  const segment = state.segment
  if (segment.kind !== "Active") return idlePiece(state, event, offset)
  const length = Math.min(
    event.sampleFrames - offset,
    recognitionChunkSamples - segment.samples,
    event.speech ? recognitionChunkSamples : recognitionQuietSamples - segment.quiet
  )
  const slice: PcmSlice = { fragmentId: event.fragmentId, offsetSamples: offset, sampleFrames: length }
  const owned = appendSlice(state, slice)
  const samples = segment.samples + length
  const quiet = event.speech ? 0 : segment.quiet + length
  const next: RecognitionState = {
    ...owned,
    segment: { kind: "Active", slices: [...segment.slices, slice], samples, quiet }
  }
  const ended = quiet >= recognitionQuietSamples
  return {
    step: continueRecognition(feedStreamingRecognition(next, event.requestId, [slice]), (current) =>
      ended || samples >= recognitionChunkSamples
        ? seal(current, event.requestId, ended)
        : unchangedRecognition(current)
    ),
    offset: offset + length
  }
}
const suppressedPiece = (state: RecognitionState, event: Window): RecognitionTransition => {
  const quiet = state.segment.kind === "Active" ? state.segment.quiet : 0
  const nextQuiet = event.speech ? 0 : quiet + event.sampleFrames
  return nextQuiet >= recognitionQuietSamples
    ? unchangedRecognition({ ...state, suppressed: false, segment: { kind: "Idle", slices: [], samples: 0 } })
    : unchangedRecognition({ ...state, segment: { kind: "Active", slices: [], samples: 0, quiet: nextQuiet } })
}
const consume = (state: RecognitionState, event: Window, offset: number): RecognitionTransition => {
  if (offset >= event.sampleFrames) return unchangedRecognition(state)
  if (state.suppressed) return suppressedPiece(state, { ...event, sampleFrames: event.sampleFrames - offset })
  const piece = state.segment.kind === "Idle" ? idlePiece(state, event, offset) : activePiece(state, event, offset)
  return continueRecognition(piece.step, (next) => consume(next, event, piece.offset))
}
export const transitionRecognitionWindow = (state: RecognitionState, event: Window): RecognitionTransition => {
  const step = event.generation === state.generation ? consume(state, event, 0) : unchangedRecognition(state)
  return releaseUnownedWindow(step, event.fragmentId)
}

/** A microphone boundary ends captured input, not the turn's recognition work. */
export const finishRecognitionCapture = (
  state: RecognitionState,
  generation: number,
  requestId: string
): RecognitionTransition => {
  const captured =
    state.segment.kind === "Active" && state.segment.samples > 0 && state.turn !== null
      ? seal(state, requestId, true)
      : releaseSlices(state, state.segment.slices)
  const next = captured.state
  const final = prepareRecognitionFinal({
    ...next,
    generation,
    suppressed: false,
    segment: { kind: "Idle", slices: [], samples: 0 },
    turn: next.turn === null ? null : { ...next.turn, ended: true }
  })
  return { state: final.state, commands: [...captured.commands, ...final.commands] }
}
