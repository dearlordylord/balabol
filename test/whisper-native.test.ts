import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { expect } from "vitest"
import { runWhisperProcess, whisperNative, type WhisperSettings } from "../src/speech-recognition/index.ts"
const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "balabol-whisper-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
)
const script = (directory: string, source: string) =>
  Effect.promise(async () => {
    const path = join(directory, "fixture.mjs")
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
it.live("executes a native fixture using private files and deletes the utterance directory on success", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    const marker = join(directory, "marker.json")
    const executable = yield* script(
      directory,
      `
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const input = arg('-f'); const output = arg('-of') + '.json';
writeFileSync(arg('-m'), JSON.stringify({ input, output, bytes: [...readFileSync(input)], inputMode: statSync(input).mode & 511, outputMode: statSync(output).mode & 511, directoryMode: statSync(input.slice(0, input.lastIndexOf('/'))).mode & 511, language: arg('-l') }));
writeFileSync(output, '{"result":{"language":"en"},"transcription":[]}');`
    )
    const settings: WhisperSettings = { provider: "whisper", executable, modelPath: marker }
    expect(yield* whisperNative.transcribe(settings, new Uint8Array([1, 2])).pipe(Effect.scoped)).toContain(
      '"language":"en"'
    )
    const raw: unknown = JSON.parse(yield* Effect.promise(() => readFile(marker, "utf8")))
    const observation = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        input: Schema.String,
        output: Schema.String,
        bytes: Schema.Array(Schema.Number),
        inputMode: Schema.Number,
        outputMode: Schema.Number,
        directoryMode: Schema.Number,
        language: Schema.String
      })
    )(raw)
    expect(observation).toMatchObject({
      bytes: [1, 2],
      inputMode: 0o600,
      outputMode: 0o600,
      directoryMode: 0o700,
      language: "auto"
    })
    expect(yield* exists(observation.input)).toBe(false)
    expect(yield* exists(observation.output)).toBe(false)
  }).pipe(Effect.scoped)
)
it.live("cancellation kills and reaps a SIGTERM-ignoring OS worker before deleting private audio", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    const marker = join(directory, "started")
    const executable = yield* script(
      directory,
      `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
writeFileSync(arg('-m') + '.pid', String(process.pid));
writeFileSync(arg('-m'), arg('-f'));
setInterval(() => {}, 1000);`
    )
    const task = yield* Effect.forkChild(
      whisperNative
        .transcribe({ provider: "whisper", executable, modelPath: marker }, new Uint8Array([1, 2]))
        .pipe(Effect.scoped)
    )
    yield* waitForFile(marker)
    const input = yield* Effect.promise(() => readFile(marker, "utf8"))
    expect(yield* exists(input)).toBe(true)
    yield* Fiber.interrupt(task)
    expect(yield* exists(input)).toBe(false)
    const pid = Number(yield* Effect.promise(() => readFile(`${marker}.pid`, "utf8")))
    expect(() => process.kill(pid, 0)).toThrow()
    expect((yield* Fiber.await(task))._tag).toBe("Failure")
  }).pipe(Effect.scoped)
)
it.live("typed process failures include missing executables, nonzero exits and bounded diagnostics", () =>
  Effect.gen(function* () {
    for (const [executable, args] of [
      ["/no/such/balabol-engine", []],
      [process.execPath, ["-e", "process.exit(4)"]],
      [process.execPath, ["-e", "process.stdout.write('x'.repeat(1100000))"]]
    ] satisfies [string, string[]][])
      expect((yield* runWhisperProcess(executable, args).pipe(Effect.result))._tag).toBe("Failure")
  })
)
it.live("startup rejects wrong engine versions and unavailable pinned models", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    let executable = yield* script(directory, "process.stdout.write('whisper.cpp version: wrong')")
    expect(
      (yield* whisperNative.prepare({ provider: "whisper", executable, modelPath: "missing" }).pipe(Effect.result))._tag
    ).toBe("Failure")
    executable = yield* script(directory, "process.stdout.write('whisper.cpp version: 1.9.5')")
    for (const modelPath of [join(directory, "missing"), executable, directory])
      expect(
        (yield* whisperNative.prepare({ provider: "whisper", executable, modelPath }).pipe(Effect.result))._tag
      ).toBe("Failure")
  }).pipe(Effect.scoped)
)

it.live("bounds result files, rejects invalid UTF-8 and recovers with a new process after failure", () =>
  Effect.gen(function* () {
    const directory = yield* temporary
    const executable = yield* script(
      directory,
      `
import { readFileSync, writeFileSync } from 'node:fs';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const mode = readFileSync(arg('-f'))[0];
if (mode === 0) process.exit(4);
const content = mode === 1 ? Buffer.from([255]) : mode === 2 ? Buffer.alloc(1048577) : Buffer.from('valid');
writeFileSync(arg('-of') + '.json', content);`
    )
    const settings: WhisperSettings = { provider: "whisper", executable, modelPath: "fixture" }
    for (const mode of [0, 1, 2])
      expect(
        (yield* whisperNative.transcribe(settings, new Uint8Array([mode])).pipe(Effect.scoped, Effect.result))._tag
      ).toBe("Failure")
    expect(yield* whisperNative.transcribe(settings, new Uint8Array([3])).pipe(Effect.scoped)).toBe("valid")
  }).pipe(Effect.scoped)
)
