import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../src/voice/activity-model.json" with { type: "json" };

export const activityModel = manifest;
export const defaultModelPath = join(homedir(), ".local/share/balabol/models/vad", activityModel.filename);

export const checkVadModel = async (path, artifact = activityModel) => {
  const size = (await stat(path)).size;
  if (size !== artifact.bytes) throw new Error("VAD model size mismatch: " + path);
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(artifact.bytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await file.read(bytes, total, bytes.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (
      total !== artifact.bytes ||
      createHash("sha256").update(bytes.subarray(0, total)).digest("hex") !== artifact.sha256
    )
      throw new Error("VAD model hash mismatch: " + path);
  } finally {
    await file.close();
  }
};

export const provisionVad = async (path, artifact = activityModel, download = fetch) => {
  try {
    await stat(path);
    await checkVadModel(path, artifact);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path + ".download-" + process.pid;
  try {
    const response = await download(artifact.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok || response.body === null) throw new Error("VAD model download failed");
    const reader = response.body.getReader();
    const contents = Buffer.alloc(artifact.bytes);
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (bytes + next.value.byteLength > artifact.bytes) throw new Error("VAD model download exceeded its bound");
        contents.set(next.value, bytes);
        bytes += next.value.byteLength;
      }
    } finally {
      await reader.cancel();
    }
    await writeFile(temporary, contents.subarray(0, bytes), { mode: 0o600, flag: "wx" });
    await checkVadModel(temporary, artifact);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const main = async (args) => {
  if (args.some((arg) => arg !== "--check")) throw new Error("Use pnpm prepare:vad [--check]");
  const path = process.env.BALABOL_VAD_MODEL ?? defaultModelPath;
  if (args.includes("--check")) await checkVadModel(path);
  else await provisionVad(path);
  console.log("Pinned speech activity model verified: " + path);
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
