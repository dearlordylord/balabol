import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { expect } from "vitest"
import { appleNative } from "../src/speech-synthesis/apple-native.ts"
import { runAppleProcess } from "../src/speech-synthesis/apple-process.ts"
const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "balabol-apple-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
)
const script = (directory: string, name: string, source: string) =>
  Effect.promise(async () => {
    const path = join(directory, name)
    await writeFile(path, `#!${process.execPath}\n${source}`)
    await chmod(path, 0o700)
    return path
  })
const exists = (path: string) =>
  Effect.promise(() =>
    stat(path).then(
      () => true,
      () => false
    )
  )
const waitForFile = (path: string): Effect.Effect<void> =>
  Effect.suspend(() =>
    exists(path).pipe(
      Effect.flatMap((found) => (found ? Effect.void : Effect.sleep(10).pipe(Effect.andThen(waitForFile(path)))))
    )
  )
const voice = { id: "installed", actualLocale: "en-US" }
it.live("uses private stdin and files, converts the complete file and cleans up", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    const marker = join(directory, "observed.json")
    const helper = yield* script(
      directory,
      "helper",
      `
import {readFileSync, writeFileSync, statSync} from 'node:fs';
if(process.argv[2] === '--voices') { process.stdout.write('[]'); process.exit(0); }
const request=JSON.parse(readFileSync(0,'utf8'));
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2), request, mode:statSync(request.outputPath).mode&511, directoryMode:statSync(request.outputPath.slice(0,request.outputPath.lastIndexOf('/'))).mode&511}));
writeFileSync(request.outputPath, 'complete');
process.stdout.write('receipt');`
    )
    const converter = yield* script(
      directory,
      "converter",
      `
import {readFileSync,writeFileSync} from 'node:fs';
if(readFileSync(process.argv[process.argv.indexOf('-i')+1],'utf8')!=='complete')process.exit(1);
writeFileSync(process.argv.at(-1),Buffer.from([1,2,3,4]));`
    )
    const settings = { provider: "apple", helperExecutable: helper, ffmpegExecutable: converter } satisfies Parameters<
      typeof appleNative.render
    >[0]
    expect(yield* appleNative.voices(settings)).toBe("[]")
    expect(yield* appleNative.render(settings, "Synthetic fixture.", voice).pipe(Effect.scoped)).toEqual({
      receipt: "receipt",
      pcm: new Uint8Array([1, 2, 3, 4])
    })
    const raw: unknown = JSON.parse(yield* Effect.promise(() => readFile(marker, "utf8")))
    const observed = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        args: Schema.Array(Schema.String),
        request: Schema.Struct({ text: Schema.String, voiceId: Schema.String, outputPath: Schema.String }),
        mode: Schema.Number,
        directoryMode: Schema.Number
      })
    )(raw)
    expect(observed).toMatchObject({
      args: [],
      request: { text: "Synthetic fixture.", voiceId: "installed" },
      mode: 0o600,
      directoryMode: 0o700
    })
    expect(yield* exists(observed.request.outputPath)).toBe(false)
  }).pipe(Effect.scoped)
)
it.live("reaps a TERM-ignoring child before deleting its files and can start a new worker", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    const marker = join(directory, "started")
    const helper = yield* script(
      directory,
      "helper",
      `
import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
process.on('SIGTERM',()=>{});
writeFileSync(${JSON.stringify(marker)},input.outputPath);
writeFileSync(${JSON.stringify(`${marker}.pid`)},String(process.pid));
setInterval(()=>{},1000);`
    )
    const task = yield* Effect.forkChild(
      appleNative
        .render({ provider: "apple", helperExecutable: helper, ffmpegExecutable: "unused" }, "Fixture.", voice)
        .pipe(Effect.scoped)
    )
    yield* waitForFile(marker)
    const path = yield* Effect.promise(() => readFile(marker, "utf8"))
    yield* Fiber.interrupt(task)
    expect(yield* exists(path)).toBe(false)
    const pid = Number(yield* Effect.promise(() => readFile(`${marker}.pid`, "utf8")))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(yield* runAppleProcess(process.execPath, ["-e", "process.stdout.write('next')"])).toBe("next")
  }).pipe(Effect.scoped)
)
it.live("bounds child output and PCM files while preserving typed failures", () =>
  Effect.gen(function* () {
    for (const [executable, args] of [
      ["/missing/apple-speech", []],
      [process.execPath, ["-e", "process.exit(1)"]],
      [process.execPath, ["-e", "process.stdout.write('x'.repeat(1100000))"]],
      [process.execPath, ["-e", "process.stderr.write('x'.repeat(1100000))"]]
    ] satisfies [string, string[]][]) {
      expect((yield* runAppleProcess(executable, args).pipe(Effect.result))._tag).toBe("Failure")
    }
    const directory = yield* temporary
    const helper = yield* script(
      directory,
      "helper",
      "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('receipt'));"
    )
    const converter = yield* script(
      directory,
      "converter",
      "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv.at(-1),Buffer.alloc(2880001));"
    )
    expect(
      (yield* appleNative
        .render({ provider: "apple", helperExecutable: helper, ffmpegExecutable: converter }, "Fixture.", voice)
        .pipe(Effect.scoped, Effect.result))._tag
    ).toBe("Failure")
  }).pipe(Effect.scoped)
)

it.live("plans via the private helper using only supplied voices without rendering or creating audio files", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    const marker = join(directory, "plan.json")
    const helper = yield* script(
      directory,
      "planner",
      `
import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),request}));
const selected=request.allowedVoices.find(voice=>voice.id===request.voiceId);
process.stdout.write(JSON.stringify({runs:[{text:request.text,voiceId:selected.id,actualLocale:selected.actualLocale}]}));`
    )
    const settings = {
      provider: "apple",
      helperExecutable: helper,
      ffmpegExecutable: "/must-not-render"
    } satisfies Parameters<typeof appleNative.plan>[0]
    const result = yield* appleNative.plan(settings, "Bonjour Привет", voice, [voice])
    expect(JSON.parse(result)).toEqual({
      runs: [{ text: "Bonjour Привет", voiceId: voice.id, actualLocale: voice.actualLocale }]
    })
    const raw: unknown = JSON.parse(yield* Effect.promise(() => readFile(marker, "utf8")))
    expect(
      yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          args: Schema.Array(Schema.String),
          request: Schema.Struct({
            text: Schema.String,
            voiceId: Schema.String,
            allowedVoices: Schema.Array(Schema.Struct({ id: Schema.String, actualLocale: Schema.String }))
          })
        })
      )(raw)
    ).toEqual({ args: ["--plan"], request: { text: "Bonjour Привет", voiceId: voice.id, allowedVoices: [voice] } })
  }).pipe(Effect.scoped)
)
