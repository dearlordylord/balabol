import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable } from "node:stream"
import { expect, it } from "vitest"
import { createActivityEngine, serveActivityWorker } from "../src/voice/activity-worker.ts"
import { speechActivityModel } from "../src/voice/index.ts"
const inference = JSON.stringify({ kind: "Infer", sequence: 1, input: Array(576).fill(0), state: Array(256).fill(0) })
it("rejects malformed commands, pre-load inference and oversized input at the actual worker engine", async () => {
  const engine = createActivityEngine()
  try {
    await expect(engine.execute(inference)).rejects.toThrow("not loaded")
    await expect(engine.execute("{broken")).rejects.toThrow()
    await expect(engine.execute("x".repeat(65537))).rejects.toThrow("Oversized")
    await expect(
      engine.execute(JSON.stringify({ kind: "Infer", sequence: 1, input: [0], state: [0] }))
    ).rejects.toThrow()
    await expect(engine.execute(JSON.stringify({ kind: "ExecuteTool", sequence: 0, tool: "none" }))).rejects.toThrow()
  } finally {
    await engine.close()
  }
})
it("validates bounded model reads, byte length and pinned digest in the real worker engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-activity-engine-"))
  const engine = createActivityEngine()
  try {
    for (const size of [16, speechActivityModel.bytes, speechActivityModel.bytes + 4096]) {
      const path = join(directory, `${size}.onnx`)
      await writeFile(path, Buffer.alloc(size))
      await expect(engine.execute(JSON.stringify({ kind: "Load", sequence: 0, modelPath: path }))).rejects.toThrow(
        "Invalid pinned"
      )
    }
    await expect(
      engine.execute(JSON.stringify({ kind: "Load", sequence: 0, modelPath: join(directory, "missing") }))
    ).rejects.toThrow()
    await expect(engine.execute(inference)).rejects.toThrow("not loaded")
  } finally {
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})
it("serves an empty stream without output and closes malformed protocol streams without a success response", async () => {
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on("data", (chunk: Buffer) => chunks.push(chunk))
  await expect(serveActivityWorker(Readable.from([]), output)).resolves.toBeUndefined()
  await expect(serveActivityWorker(Readable.from([`${inference}\n`]), output)).rejects.toThrow("not loaded")
  expect(Buffer.concat(chunks).length).toBe(0)
  output.destroy()
})
const model = process.env.BALABOL_TEST_ACTIVITY_MODEL
it.skipIf(model === undefined)(
  "loads the pinned CPU model and validates its inference through the in-process command engine",
  async () => {
    if (model === undefined) throw new Error("Missing model path")
    const engine = createActivityEngine()
    try {
      expect(await engine.execute(JSON.stringify({ kind: "Load", sequence: 0, modelPath: model }))).toEqual({
        kind: "Ready",
        sequence: 0
      })
      await expect(engine.execute(JSON.stringify({ kind: "Load", sequence: 2, modelPath: model }))).rejects.toThrow(
        "already loaded"
      )
      const result = await engine.execute(inference)
      expect(result.kind).toBe("Result")
      if (result.kind === "Result") {
        expect(result.probability).toBeLessThan(0.5)
        expect(result.state).toHaveLength(256)
      }
    } finally {
      await engine.close()
    }
  }
)
