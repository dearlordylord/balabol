import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { Schema } from "effect";

const maximumLineBytes = 32 * 1024 * 1024;
const maximumExpandedBytes = 40 * 1024 * 1024 * 1024;
const provisionDeadline = 60 * 60 * 1000;
const Artifact = Schema.Struct({
  url: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(4 * 1024 * 1024 * 1024)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export const verifyArchive = async (path, rawArtifact, signal) => {
  const artifact = Schema.decodeUnknownSync(Artifact)(rawArtifact);
  if ((await stat(path)).size !== artifact.bytes) throw new Error("Wiktionary archive size mismatch");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256) throw new Error("Wiktionary archive hash mismatch");
};

/** A failed or cancelled download never replaces an existing archive. */
export const downloadArchive = async (path, rawArtifact, signal, fetcher = fetch) => {
  const artifact = Schema.decodeUnknownSync(Artifact)(rawArtifact);
  try {
    await verifyArchive(path, artifact, signal);
    return;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.download`;
  try {
    const response = await fetcher(artifact.url, { signal });
    if (!response.ok || response.body === null) throw new Error("Wiktionary archive download failed");
    const output = await open(temporary, "wx", 0o600);
    try {
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > artifact.bytes) throw new Error("Wiktionary download exceeded its byte limit");
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    await verifyArchive(temporary, artifact, signal);
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Stream JSONL with independent compressed, expanded and per-record bounds. */
export async function* archiveLines(path, signal) {
  const input = createReadStream(path, { signal });
  const decoded = input.pipe(createGunzip());
  input.on("error", (error) => decoded.destroy(error));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let expanded = 0;
  let records = 0;
  try {
    for await (const chunk of decoded) {
      expanded += chunk.byteLength;
      if (expanded > maximumExpandedBytes) throw new Error("Expanded Wiktionary data exceeded its byte limit");
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        if (Buffer.byteLength(line) > maximumLineBytes) throw new Error("Wiktionary record exceeded its byte limit");
        records += 1;
        if (records % 100000 === 0)
          console.log(`Read ${records} source records (${Math.round(expanded / 1024 / 1024)} MiB expanded).`);
        yield line;
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > maximumLineBytes) throw new Error("Wiktionary record exceeded its byte limit");
    }
    pending += decoder.decode();
    if (pending.length) yield pending;
  } finally {
    input.destroy();
    decoded.destroy();
  }
}

export const main = async (args) => {
  if (args.some((arg) => arg !== "--check")) throw new Error("Use pnpm prepare:dictionary [--check]");
  const { Dictionary, DictionarySource, sqliteDictionaryLayer } = await import("../src/dictionary/index.ts");
  const { buildDictionaryCatalog } = await import("../src/dictionary/provision.ts");
  const { Effect } = await import("effect");
  const manifest = JSON.parse(await readFile(new URL("./wiktionary-source.json", import.meta.url), "utf8"));
  const artifact = Schema.decodeUnknownSync(Artifact)(manifest);
  const metadata = Schema.decodeUnknownSync(DictionarySource)({
    ...manifest.source,
    url: artifact.url,
    archiveSha256: artifact.sha256,
  });
  const directory = join(homedir(), ".local/share/balabol/dictionaries");
  const destination = process.env.BALABOL_DICTIONARY_PATH ?? join(directory, "wiktionary.sqlite");
  const checkCatalog = async (path) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dictionary = yield* Dictionary;
          for (const [language, word] of [
            ["en", "dictionary"],
            ["fr", "mot"],
            ["ru", "слово"],
          ]) {
            const page = yield* dictionary.lookup({ language, word, limit: 1 });
            if (JSON.stringify(page.source) !== JSON.stringify(metadata) || page.entries.length === 0)
              throw new Error(
                "Dictionary catalog is incomplete or does not match the pinned source; run pnpm prepare:dictionary",
              );
          }
        }).pipe(Effect.provide(sqliteDictionaryLayer(path))),
      ),
    );
  };
  if (!args.includes("--check")) {
    const interrupt = new AbortController();
    const stop = () => interrupt.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const signal = AbortSignal.any([interrupt.signal, AbortSignal.timeout(provisionDeadline)]);
    try {
      const archive = join(directory, "wiktextract-en.jsonl.gz");
      console.log("Verifying/downloading the pinned Wiktionary archive outside Git...");
      await downloadArchive(archive, artifact, signal);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      console.log("Building the staged ru/fr/en catalog; the previous catalog remains available...");
      const result = await buildDictionaryCatalog({
        source: archiveLines(archive, signal),
        destination,
        metadata,
        languages: ["ru", "fr", "en"],
        signal,
        validate: checkCatalog,
      });
      console.log(`Published ${result.entries} dictionary entries.`);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } else {
    await checkCatalog(destination);
  }
  console.log("Local dictionary catalog is ready; restart the backend to open an updated catalog.");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Dictionary preparation failed");
    console.error("Dictionary is unavailable. Run pnpm prepare:dictionary; restart the backend after preparation.");
    process.exitCode = 1;
  });
}
