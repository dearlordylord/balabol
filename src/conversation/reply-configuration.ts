import { Context, Schema } from "effect"

const maximumModelNameLength = 200
export const ReplySettings = Schema.Struct({
  answerProvider: Schema.Literal("fake"),
  answerModel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumModelNameLength)),
  deltaMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  contextWaitAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  contextWaitMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  attachmentMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 }))
})
export type ReplySettings = typeof ReplySettings.Type
export const defaultReplySettings: ReplySettings = {
  answerProvider: "fake",
  answerModel: "sol",
  deltaMillis: 80,
  contextWaitAttempts: 100,
  contextWaitMillis: 20,
  attachmentMillis: 5000
}
export class ReplyConfiguration extends Context.Service<ReplyConfiguration, ReplySettings>()(
  "balabol/conversation/reply-configuration"
) {}
