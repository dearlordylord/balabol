import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema, Clock } from "effect"
import { expect, it } from "vitest"
import {
  SpeechActivity,
  activityProcessRuntime,
  sileroSpeechActivityLayer,
  type VoiceFrame
} from "../src/voice/index.ts"
const audio = (): VoiceFrame => ({
  sampleRate: 16000,
  channels: 1,
  samplesPerChannel: 320,
  data: new Int16Array(320).fill(1200)
})
it("kills and reaps a never-returning native worker then recovers on a fresh request in the same Layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-activity-child-"))
  try {
    const worker = join(directory, "worker.mjs")
    const marker = join(directory, "runs")
    await writeFile(marker, "0")
    await writeFile(
      worker,
      `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
let run = 0; let markerPath;
for await (const line of createInterface({input:process.stdin})) {
 const command=JSON.parse(line);
 if(command.kind==='Load') {
  markerPath=command.modelPath;
  run=Number(readFileSync(command.modelPath,'utf8'))+1;
  writeFileSync(command.modelPath,String(run));
  appendFileSync(command.modelPath+'.pids',process.pid+'\\n');
  writeFileSync(command.modelPath+'.env',JSON.stringify(Object.keys(process.env)));
  console.log(JSON.stringify({kind:'Ready',sequence:command.sequence}));
 } else { appendFileSync(markerPath+'.infer',process.pid+'\\n');
 if(run%2===0) console.log(JSON.stringify({kind:'Result',sequence:command.sequence,probability:0.9,state:Array(256).fill(0)})); }
}
`
    )
    const layer = sileroSpeechActivityLayer({ modelPath: marker }, activityProcessRuntime(pathToFileURL(worker)))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis
          const activity = yield* SpeechActivity
          const stream = yield* activity.open()
          yield* stream.push(audio())
          const failure = yield* stream.push(audio()).pipe(Effect.result)
          expect(failure._tag).toBe("Failure")
          const firstPid = Number((yield* Effect.promise(() => readFile(`${marker}.pids`, "utf8"))).trim())
          expect(() => process.kill(firstPid, 0)).toThrow()
          expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(3000)
          expect(yield* stream.push(audio())).toEqual([])
          expect((yield* stream.push(audio()))[0]?.speech).toBe(true)
          const pids = (yield* Effect.promise(() => readFile(`${marker}.pids`, "utf8"))).trim().split("\n")
          expect(pids).toHaveLength(2)
          expect(pids[0]).not.toBe(pids[1])
          const raw: unknown = JSON.parse(yield* Effect.promise(() => readFile(`${marker}.env`, "utf8")))
          expect(
            (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(raw)).every(
              (key) => key === "__CF_USER_TEXT_ENCODING"
            )
          ).toBe(true)
        })
      ).pipe(Effect.provide(layer))
    )
    const closeStarted = await Effect.runPromise(Clock.currentTimeMillis)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* (yield* SpeechActivity).open()
          yield* stream.push(audio())
          yield* stream.push(audio()).pipe(Effect.forkChild)
          const pids = (yield* Effect.promise(() => readFile(`${marker}.pids`, "utf8"))).trim().split("\n")
          const current = pids.at(-1)
          for (let attempt = 0; attempt < 100; attempt++) {
            const infer = yield* Effect.promise(() => readFile(`${marker}.infer`, "utf8"))
            if (
              infer
                .trim()
                .split("\n")
                .includes(current ?? "missing")
            )
              return
            yield* Effect.sleep(5)
          }
          throw new Error("Never-returning inference did not start")
        })
      ).pipe(Effect.provide(layer))
    )
    expect((await Effect.runPromise(Clock.currentTimeMillis)) - closeStarted).toBeLessThan(1500)
    const pids = (await readFile(`${marker}.pids`, "utf8")).trim().split("\n").map(Number)
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
