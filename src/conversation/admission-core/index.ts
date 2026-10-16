import { Schema } from "effect"
import native, {
  type Admission,
  type AdmissionEvent,
  type Command,
  type Decision,
  type Eligibility,
  type OriginClock,
  type Phase
} from "./generated/core.mjs"

export type { Admission, AdmissionEvent, Command, Decision, Eligibility, OriginClock, Phase }

const Token = Schema.BigInt.check(Schema.makeFilter((value) => value >= 0n && value <= 281474976710655n))
const PhaseSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("Reserved") }),
  Schema.Struct({ $: Schema.Literal("Pending") }),
  Schema.Struct({ $: Schema.Literal("AcceptedWaiting") }),
  Schema.Struct({ $: Schema.Literal("StartReserved") }),
  Schema.Struct({ $: Schema.Literal("SupersededReserved") }),
  Schema.Struct({ $: Schema.Literal("Started") }),
  Schema.Struct({ $: Schema.Literal("AcceptedExisting") }),
  Schema.Struct({ $: Schema.Literal("Recoverable") }),
  Schema.Struct({ $: Schema.Literal("Rejected") })
]) satisfies Schema.Codec<Phase>
const EligibilitySchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("Eligible") }),
  Schema.Struct({ $: Schema.Literal("Superseded") })
]) satisfies Schema.Codec<Eligibility>
const OriginClockSchema = Schema.Struct({
  $: Schema.Literal("OriginClock"),
  sourceSequence: Token,
  currentSourceSequence: Token,
  originRevision: Token,
  currentRevision: Token
}) satisfies Schema.Codec<OriginClock>
const AdmissionSchema = Schema.Struct({
  $: Schema.Literal("Admission"),
  operation: Token,
  payload: Token,
  revision: Token,
  phase: PhaseSchema,
  eligibility: EligibilitySchema
}) satisfies Schema.Codec<Admission>
const EventSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("Submit"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("Accepted"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("ExistingAccepted"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("AdmissionFailed"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("AdmissionRejected"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("PrerequisiteReady"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("AuthorizeStart"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("Fence") }),
  Schema.Struct({ $: Schema.Literal("CaptureClosed") })
]) satisfies Schema.Codec<AdmissionEvent>
const CommandSchema = Schema.Union([
  Schema.Struct({ $: Schema.Literal("NoCommand") }),
  Schema.Struct({ $: Schema.Literal("Persist"), operation: Token, payload: Token }),
  Schema.Struct({ $: Schema.Literal("AcknowledgeReceipt"), operation: Token, payload: Token }),
  Schema.Struct({ $: Schema.Literal("RequestStart"), operation: Token, payload: Token, revision: Token }),
  Schema.Struct({ $: Schema.Literal("StartResponse"), operation: Token, payload: Token, revision: Token }),
  Schema.Struct({ $: Schema.Literal("RecordSuperseded"), operation: Token, payload: Token, revision: Token }),
  Schema.Struct({ $: Schema.Literal("RevokeStart"), operation: Token }),
  Schema.Struct({ $: Schema.Literal("ReportFailure"), operation: Token })
]) satisfies Schema.Codec<Command>
const DecisionSchema = Schema.Struct({
  $: Schema.Literal("Decision"),
  state: AdmissionSchema,
  command: CommandSchema
}) satisfies Schema.Codec<Decision>
const InitializationSchema = Schema.Struct({ operation: Token, payload: Token, clock: OriginClockSchema })

const Boundary = Schema.Literals(["Initialization", "Admission", "Event", "Initialized", "Decision"])
export class CoreBoundaryFailure extends Schema.TaggedError<CoreBoundaryFailure>()("CoreBoundaryFailure", {
  boundary: Boundary,
  message: Schema.String
}) {}
const decode = <A>(schema: Schema.Codec<A>, input: unknown, boundary: typeof Boundary.Type): A => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
  } catch {
    throw new CoreBoundaryFailure({ boundary, message: `Invalid admission core ${boundary.toLowerCase()} value` })
  }
}

// This boundary validates the qualified native ABI. Eligibility and all lifecycle
// decisions belong exclusively to the compiled Bend transition.
const core = {
  initialize: (operation: bigint, payload: bigint, clock: OriginClock): Admission => {
    const input = decode(InitializationSchema, { operation, payload, clock }, "Initialization")
    return decode(AdmissionSchema, native.initialize(input.operation, input.payload, input.clock), "Initialized")
  },
  transition: (state: Admission, event: AdmissionEvent): Decision => {
    const admission = decode(AdmissionSchema, state, "Admission")
    const input = decode(EventSchema, event, "Event")
    return decode(DecisionSchema, native.transition(admission, input), "Decision")
  }
}
export default core
