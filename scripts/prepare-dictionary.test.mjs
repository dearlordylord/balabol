import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { archiveLines, downloadArchive, verifyArchive } from "./prepare-dictionary.mjs";

const bytes = Buffer.from("public dictionary fixture");
const artifact = {
  url: "https://example.invalid/dictionary.gz",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const temporary = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-download-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("provisions only verified bytes and reuses a verified archive without network", () =>
  temporary(async (directory) => {
    const path = join(directory, "archive.gz");
    let requests = 0;
    const fetcher = async () => {
      requests += 1;
      return new Response(bytes);
    };
    await downloadArchive(path, artifact, undefined, fetcher);
    await verifyArchive(path, artifact);
    await downloadArchive(path, artifact, undefined, fetcher);
    assert.equal(requests, 1);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(directory), ["archive.gz"]);
  }));

test("failed, oversized and hash-invalid downloads retain the previous archive and remove staging", () =>
  temporary(async (directory) => {
    const path = join(directory, "archive.gz");
    const previous = Buffer.from("previous data");
    await writeFile(path, previous);
    for (const response of [
      new Response(null, { status: 503 }),
      new Response(Buffer.alloc(bytes.length + 1)),
      new Response(Buffer.alloc(bytes.length)),
    ]) {
      await assert.rejects(downloadArchive(path, artifact, undefined, async () => response));
      assert.deepEqual(await readFile(path), previous);
      assert.deepEqual(await readdir(directory), ["archive.gz"]);
    }
  }));

test("cancelled acquisition cannot replace the previous archive", () =>
  temporary(async (directory) => {
    const path = join(directory, "archive.gz");
    await writeFile(path, "previous data");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      downloadArchive(path, artifact, controller.signal, async () => {
        throw new Error("must not fetch");
      }),
    );
    assert.equal(await readFile(path, "utf8"), "previous data");
  }));

test("streams UTF-8 gzip JSONL and rejects corruption rather than publishing a partial catalog", () =>
  temporary(async (directory) => {
    const path = join(directory, "archive.gz");
    await writeFile(path, gzipSync('{"word":"étude"}\n{"word":"слово"}'));
    assert.deepEqual(await Array.fromAsync(archiveLines(path)), ['{"word":"étude"}', '{"word":"слово"}']);
    await writeFile(path, Buffer.from("invalid gzip"));
    await assert.rejects(Array.fromAsync(archiveLines(path)));
    await writeFile(path, gzipSync(Buffer.from([0xff])));
    await assert.rejects(Array.fromAsync(archiveLines(path)));
  }));
