import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkVadModel, provisionVad } from "./prepare-vad.mjs";
const artifact = {
  bytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  url: "https://example.invalid/pinned-model",
};

test("provisions only a verified bounded artifact and reuses it without another download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-vad-provision-"));
  try {
    const path = join(directory, "model.onnx");
    let calls = 0;
    const download = async () => {
      calls++;
      return new Response("abc");
    };
    await provisionVad(path, artifact, download);
    assert.equal(await readFile(path, "utf8"), "abc");
    await provisionVad(path, artifact, download);
    assert.equal(calls, 1);
    await writeFile(path, "abd");
    await assert.rejects(provisionVad(path, artifact, download), /hash mismatch/);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects oversized, truncated or tampered downloads without installing an artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-vad-invalid-"));
  try {
    const path = join(directory, "model.onnx");
    for (const value of ["abcd", "ab", "abd"]) {
      await assert.rejects(provisionVad(path, artifact, async () => new Response(value)));
      await assert.rejects(readFile(path), { code: "ENOENT" });
      await assert.rejects(readFile(path + ".download-" + process.pid), { code: "ENOENT" });
    }
    await assert.rejects(checkVadModel(path, artifact), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
