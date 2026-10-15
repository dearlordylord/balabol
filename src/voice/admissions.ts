import { randomUUID, createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import type { DatabaseSync } from "node:sqlite"
import { LanguageTag, LanguageSpans, validLanguageSpans } from "../language/index.ts"
import type { LanguageSpan } from "../language/index.ts"
import { SpeechAdmission } from "./recovery-contracts.ts"
import { failed, VoiceFailed } from "./contracts.ts"
const maximumCheckpoints = 8
const maximumText = 100000
const BeginAdmission = Schema.Struct({
  ...SpeechAdmission.fields,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumText)),
  languageSpans: Schema.optionalKey(LanguageSpans),
  detectedLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag))
})
export const speechAnnotationsHash = (spans: readonly LanguageSpan[]) =>
  speechPayloadHash(JSON.stringify(Schema.decodeUnknownSync(LanguageSpans)(spans)))
export const speechDetectionHash = (language: string | null | undefined) =>
  speechPayloadHash(JSON.stringify(Schema.decodeUnknownSync(Schema.NullOr(LanguageTag))(language ?? null)))
export const speechPayloadHash = (text: string) => createHash("sha256").update(text, "utf16le").digest("hex")
const Checkpoint = Schema.Struct({
  ...SpeechAdmission.fields,
  payloadHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  languageSpansHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  detectedLanguageHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  state: Schema.Literals(["Open", "Sealed"])
})
const Checkpoints = Schema.Array(Checkpoint).check(Schema.isMaxLength(maximumCheckpoints))
export type AdmissionCheckpoint = typeof Checkpoint.Type
export class VoiceAdmissions extends Context.Service<
  VoiceAdmissions,
  {
    readonly backendIncarnationId: string
    begin: (admission: typeof BeginAdmission.Type) => Effect.Effect<void, VoiceFailed>
    seal: (admission: SpeechAdmission) => Effect.Effect<void, VoiceFailed>
    find: (admission: SpeechAdmission) => Effect.Effect<AdmissionCheckpoint | null, VoiceFailed>
  }
>()("balabol/voice-admissions") {}
const unavailable = (error: unknown) =>
  error instanceof VoiceFailed ? error : failed("StorageUnavailable", "Speech admission evidence is unavailable")
const parse = (raw: SpeechAdmission) =>
  Schema.decodeUnknownEffect(SpeechAdmission)(raw).pipe(
    Effect.mapError(() => failed("InvalidInput", "Invalid speech admission association"))
  )
const transaction = (database: DatabaseSync, run: () => void) => {
  database.exec("BEGIN IMMEDIATE")
  try {
    run()
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
// The caller owns the existing exclusive Memory writer lease and database lifetime.
export const sqliteVoiceAdmissions = (database: DatabaseSync) =>
  Layer.effect(
    VoiceAdmissions,
    Effect.gen(function* () {
      const backendIncarnationId = randomUUID()
      const rows = () =>
        Schema.decodeUnknownSync(Checkpoints)(
          database
            .prepare(
              "SELECT backendIncarnationId,sessionId,deliveryId,payloadHash,languageSpansHash,detectedLanguageHash,state FROM voice_admissions ORDER BY rowid LIMIT ?"
            )
            .all(maximumCheckpoints + 1)
        )
      yield* Effect.try({
        try: () => {
          database.exec(
            "CREATE TABLE IF NOT EXISTS voice_admissions(deliveryId TEXT PRIMARY KEY,backendIncarnationId TEXT NOT NULL,sessionId TEXT NOT NULL,payloadHash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('Open','Sealed')))"
          )
          const columns = database.prepare("SELECT name FROM pragma_table_info('voice_admissions') LIMIT 8").all()
          if (!columns.some((row) => row.name === "languageSpansHash"))
            database.exec(
              `ALTER TABLE voice_admissions ADD COLUMN languageSpansHash TEXT NOT NULL DEFAULT '${speechAnnotationsHash([])}'`
            )
          if (!columns.some((row) => row.name === "detectedLanguageHash"))
            database.exec(
              `ALTER TABLE voice_admissions ADD COLUMN detectedLanguageHash TEXT NOT NULL DEFAULT '${speechDetectionHash(null)}'`
            )
          rows()
          database
            .prepare("UPDATE voice_admissions SET state='Sealed' WHERE backendIncarnationId<>?")
            .run(backendIncarnationId)
        },
        catch: unavailable
      })
      const find = (admission: SpeechAdmission) => {
        const row = database
          .prepare(
            "SELECT backendIncarnationId,sessionId,deliveryId,payloadHash,languageSpansHash,detectedLanguageHash,state FROM voice_admissions WHERE deliveryId=? AND backendIncarnationId=? AND sessionId=? LIMIT 1"
          )
          .get(admission.deliveryId, admission.backendIncarnationId, admission.sessionId)
        return row === undefined ? null : Schema.decodeUnknownSync(Checkpoint)(row)
      }
      const begin = (admission: typeof BeginAdmission.Type) =>
        transaction(database, () => {
          if (!validLanguageSpans(admission.text, admission.languageSpans ?? []))
            throw failed("InvalidInput", "Invalid finalized language annotations")
          if (admission.backendIncarnationId !== backendIncarnationId)
            throw failed("InvalidInput", "Only the current backend may begin admission")
          if (find(admission) !== null) throw failed("AdmissionConflict", "Speech identity already registered")
          const checkpoints = rows()
          if (checkpoints.length >= maximumCheckpoints) {
            const sealed = checkpoints.find((row) => row.state === "Sealed")
            if (sealed === undefined) throw failed("Overloaded", "Speech admission evidence capacity exceeded")
            database.prepare("DELETE FROM voice_admissions WHERE deliveryId=?").run(sealed.deliveryId)
          }
          database
            .prepare(
              "INSERT INTO voice_admissions(deliveryId,backendIncarnationId,sessionId,payloadHash,languageSpansHash,detectedLanguageHash,state) VALUES(?,?,?,?,?,?,'Open')"
            )
            .run(
              admission.deliveryId,
              admission.backendIncarnationId,
              admission.sessionId,
              speechPayloadHash(admission.text),
              speechAnnotationsHash(admission.languageSpans ?? []),
              speechDetectionHash(admission.detectedLanguage)
            )
        })
      return VoiceAdmissions.of({
        backendIncarnationId,
        begin: (raw) =>
          Schema.decodeUnknownEffect(BeginAdmission)(raw).pipe(
            Effect.mapError(() => failed("InvalidInput", "Invalid finalized speech admission")),
            Effect.flatMap((admission) => Effect.try({ try: () => begin(admission), catch: unavailable }))
          ),
        seal: (raw) =>
          parse(raw).pipe(
            Effect.flatMap((admission) =>
              Effect.try({
                try: () => {
                  database
                    .prepare(
                      "UPDATE voice_admissions SET state='Sealed' WHERE deliveryId=? AND backendIncarnationId=? AND sessionId=?"
                    )
                    .run(admission.deliveryId, admission.backendIncarnationId, admission.sessionId)
                },
                catch: unavailable
              })
            )
          ),
        find: (raw) =>
          parse(raw).pipe(Effect.flatMap((admission) => Effect.try({ try: () => find(admission), catch: unavailable })))
      })
    })
  )
