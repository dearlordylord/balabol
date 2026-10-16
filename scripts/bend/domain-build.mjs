import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { domainDeclarations } from "./domain-abi.mjs";

export function buildDomainCore(sourcePath, outputDirectory) {
  const version = spawnSync("bend", ["version"], { encoding: "utf8", timeout: 5000 });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== "bend 2.0.36")
    throw new Error("The production ABI is qualified only for Bend 2.0.36");
  const source = readFileSync(sourcePath, "utf8");
  const declarations = domainDeclarations(source);
  mkdirSync(outputDirectory, { recursive: true });
  const snapshot = mkdtempSync(join(tmpdir(), "balabol-bend-build-"));
  try {
    const snapshotSource = join(snapshot, "core.bend");
    const snapshotOutput = join(snapshot, "core.mjs");
    writeFileSync(snapshotSource, source);
    const result = spawnSync("bend", [snapshotSource, "-o", snapshotOutput], { encoding: "utf8", timeout: 15000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Bend module compilation failed:\n${result.stdout}${result.stderr}`);
    if (readFileSync(sourcePath, "utf8") !== source)
      throw new Error("Bend source changed during compilation; refusing a stale artifact/declaration pair");
    writeFileSync(resolve(outputDirectory, "core.mjs"), readFileSync(snapshotOutput));
    writeFileSync(resolve(outputDirectory, "core.d.mts"), declarations);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error("Usage: node scripts/bend/domain-build.mjs <core.bend> <output-directory>");
  buildDomainCore(source, output);
}
