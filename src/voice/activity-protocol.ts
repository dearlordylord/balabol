import { Schema } from "effect"
import artifact from "./activity-model.json" with { type: "json" }
export const speechActivityModel = Object.freeze(artifact)
export const activityLayout = { stateLayers: 2, stateWidth: 128, stateValues: 256, batch: 1, pcmScale: 32768 }
export const maximumActivityLineBytes = 65536
const fixedFloats = (length: number) =>
  Schema.Array(Schema.Number.check(Schema.isFinite())).check(Schema.isMinLength(length), Schema.isMaxLength(length))
const maximumModelPathLength = 4096
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const ActivityCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("Load"),
    sequence: Sequence,
    modelPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumModelPathLength))
  }),
  Schema.Struct({
    kind: Schema.Literal("Infer"),
    sequence: Sequence,
    input: fixedFloats(artifact.windowSamples + artifact.contextSamples),
    state: fixedFloats(activityLayout.stateValues)
  })
])
export type ActivityCommand = typeof ActivityCommand.Type
export const ActivityResponse = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Ready"), sequence: Sequence }),
  Schema.Struct({
    kind: Schema.Literal("Result"),
    sequence: Sequence,
    probability: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    state: fixedFloats(activityLayout.stateValues)
  }),
  Schema.Struct({ kind: Schema.Literal("Failed"), sequence: Sequence })
])
export type ActivityResponse = typeof ActivityResponse.Type
export const parseActivityResponse = (line: string) => Schema.decodeUnknownSync(ActivityResponse)(JSON.parse(line))
