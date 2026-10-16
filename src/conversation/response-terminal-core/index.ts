import { Schema } from "effect"
import native, {
  type Outcome,
  type Intent,
  type TerminalState,
  type TerminalEvent,
  type Command,
  type Decision
} from "./generated/core.mjs"

export type { Outcome, Intent, TerminalState, TerminalEvent, Command, Decision }
const Token = Schema.BigInt.check(Schema.makeFilter((value) => value >= 0n && value <= 281474976710655n))
const OutcomeSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("Completed") }),
  Schema.Struct({ $: Schema.Literal("Interrupted") })
]) satisfies Schema.Codec<Outcome>
const IntentSchema = Schema.Struct({
  $: Schema.Literal("Intent"),
  operation: Token,
  payload: Token,
  outcome: OutcomeSchema
}) satisfies Schema.Codec<Intent>
const StateSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("Open"), attempt: Token }),
  Schema.Struct({ $: Schema.Literal("Persisting"), attempt: Token, intent: IntentSchema, invocation: Token }),
  Schema.Struct({ $: Schema.Literal("Retryable"), attempt: Token, intent: IntentSchema, invocation: Token }),
  Schema.Struct({ $: Schema.Literal("Stored"), attempt: Token, intent: IntentSchema })
]) satisfies Schema.Codec<TerminalState>
const EventSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("Select"), attempt: Token, intent: IntentSchema, invocation: Token }),
  Schema.Struct({ $: Schema.Literal("StorageFailed"), attempt: Token, operation: Token, invocation: Token }),
  Schema.Struct({ $: Schema.Literal("RetryPersistence"), attempt: Token, operation: Token, invocation: Token }),
  Schema.Struct({ $: Schema.Literal("StoredAck"), attempt: Token, intent: IntentSchema })
]) satisfies Schema.Codec<TerminalEvent>
const CommandSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("NoCommand") }),
  Schema.Struct({ $: Schema.Literal("Persist"), attempt: Token, intent: IntentSchema, invocation: Token })
]) satisfies Schema.Codec<Command>
const DecisionSchema = Schema.Struct({
  $: Schema.Literal("Decision"),
  state: StateSchema,
  command: CommandSchema
}) satisfies Schema.Codec<Decision>
const Boundary = Schema.Literals(["Attempt", "State", "Event", "Initialized", "Decision"])
export class TerminalCoreBoundaryFailure extends Schema.TaggedError<TerminalCoreBoundaryFailure>()(
  "TerminalCoreBoundaryFailure",
  { boundary: Boundary, message: Schema.String }
) {}
const decode = <A>(schema: Schema.Codec<A>, input: unknown, boundary: typeof Boundary.Type): A => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
  } catch {
    throw new TerminalCoreBoundaryFailure({
      boundary,
      message: `Invalid terminal core ${boundary.toLowerCase()} value`
    })
  }
}

// Validate the qualified native representation; all terminal decisions remain in Bend.
const core = {
  initialize: (attempt: bigint): TerminalState =>
    decode(StateSchema, native.initialize(decode(Token, attempt, "Attempt")), "Initialized"),
  transition: (state: TerminalState, event: TerminalEvent): Decision =>
    decode(
      DecisionSchema,
      native.transition(decode(StateSchema, state, "State"), decode(EventSchema, event, "Event")),
      "Decision"
    )
}
export default core
