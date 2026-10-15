import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Readable, Writable } from "node:stream"
import { createInterface } from "node:readline"
import { Schema } from "effect"
import {
  ActivityCommand,
  ActivityResponse,
  activityLayout,
  maximumActivityLineBytes,
  speechActivityModel
} from "./activity-protocol.ts"
const Tensor = Schema.Struct({
  type: Schema.Literal("float32"),
  dims: Schema.Array(Schema.Int),
  data: Schema.instanceOf(Float32Array)
})
const tensor = (raw: unknown, shape: string, length: number) =>
  Schema.decodeUnknownSync(
    Tensor.check(
      Schema.makeFilter((value) => value.dims.join(",") === shape),
      Schema.makeFilter((value) => value.data.length === length)
    )
  )(raw).data
const readModel = async (path: string) => {
  const file = await open(path, "r")
  try {
    const bytes = Buffer.alloc(speechActivityModel.bytes + 1)
    let offset = 0
    let read = await file.read(bytes, offset, bytes.length - offset, offset)
    while (read.bytesRead > 0 && offset + read.bytesRead < bytes.length) {
      offset += read.bytesRead
      read = await file.read(bytes, offset, bytes.length - offset, offset)
    }
    return bytes.subarray(0, offset + read.bytesRead)
  } finally {
    await file.close()
  }
}
const load = async (path: string) => {
  const bytes = await readModel(path)
  if (
    bytes.length !== speechActivityModel.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== speechActivityModel.sha256
  )
    throw new Error("Invalid pinned activity model")
  const ort = await import("onnxruntime-node")
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential"
  })
  return { ort, session }
}
const infer = async (model: Awaited<ReturnType<typeof load>>, command: Extract<ActivityCommand, { kind: "Infer" }>) => {
  const { ort, session } = model
  const output = await session.run({
    input: new ort.Tensor("float32", Float32Array.from(command.input), [
      activityLayout.batch,
      speechActivityModel.contextSamples + speechActivityModel.windowSamples
    ]),
    state: new ort.Tensor("float32", Float32Array.from(command.state), [
      activityLayout.stateLayers,
      activityLayout.batch,
      activityLayout.stateWidth
    ]),
    sr: new ort.Tensor("int64", BigInt64Array.of(BigInt(speechActivityModel.sampleRateHz)), [])
  })
  return {
    kind: "Result",
    sequence: command.sequence,
    probability: tensor(output.output, "1,1", 1)[0],
    state: [...tensor(output.stateN, "2,1,128", activityLayout.stateValues)]
  }
}
export const createActivityEngine = () => {
  let model: Awaited<ReturnType<typeof load>> | undefined
  const execute = async (line: string): Promise<ActivityResponse> => {
    if (Buffer.byteLength(line) > maximumActivityLineBytes) throw new Error("Oversized activity command")
    const command = Schema.decodeUnknownSync(ActivityCommand)(JSON.parse(line))
    if (command.kind === "Load") {
      if (model !== undefined) throw new Error("Activity model is already loaded")
      model = await load(command.modelPath)
      return { kind: "Ready", sequence: command.sequence }
    }
    if (model === undefined) throw new Error("Activity model is not loaded")
    return Schema.decodeUnknownSync(ActivityResponse)(await infer(model, command))
  }
  return {
    execute,
    close: async () => {
      await model?.session.release()
    }
  }
}
/** The same bounded command engine serves the isolated process and protocol fixtures. */
export const serveActivityWorker = async (input: Readable, output: Writable) => {
  const lines = createInterface({ input, crlfDelay: Infinity })
  const engine = createActivityEngine()
  try {
    for await (const line of lines) output.write(`${JSON.stringify(await engine.execute(line))}\n`)
  } finally {
    lines.close()
    await engine.close()
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void serveActivityWorker(process.stdin, process.stdout).catch(() => process.exit(1))
}
