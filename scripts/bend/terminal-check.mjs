import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDomainCore } from "./domain-build.mjs";
import { checkMutantProof } from "./admission-proof-controls.mjs";
import { falsifyTerminal } from "./terminal-falsify.mjs";
import { terminalMutants } from "../../src/conversation/response-terminal-core/mutants.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(directory, "../../src/conversation/response-terminal-core");
const temporary = mkdtempSync(join(directory, ".qualification-"));
const source = readFileSync(join(sourceDirectory, "core.bend"), "utf8");
try {
  buildDomainCore(join(sourceDirectory, "core.bend"), temporary);
  const { default: core } = await import(pathToFileURL(join(temporary, "core.mjs")).href);
  const cases = falsifyTerminal(core);
  process.stdout.write(`Terminal laws: ${cases} reachable-state/event cases and stale-invocation traces passed\n`);
  for (const mutant of terminalMutants) {
    const mutantDirectory = join(temporary, mutant.name);
    mkdirSync(mutantDirectory);
    assert.equal(source.split(mutant.from).length, 2, `Mutant target must be unique: ${mutant.name}`);
    writeFileSync(join(mutantDirectory, "core.bend"), source.replace(mutant.from, mutant.to));
    buildDomainCore(join(mutantDirectory, "core.bend"), mutantDirectory);
    const { default: mutated } = await import(pathToFileURL(join(mutantDirectory, "core.mjs")).href);
    assert.throws(
      () => falsifyTerminal(mutated),
      { name: "AssertionError" },
      `Semantic mutant survived: ${mutant.name}`,
    );
    if (!process.argv.includes("--falsify-only"))
      checkMutantProof({
        wrapper: join(directory, "bend-check"),
        sourceDirectory,
        mutantDirectory,
        original: source,
        mutant,
      });
  }
  process.stdout.write(`Terminal falsifier controls: ${terminalMutants.length} compiling semantic mutants rejected\n`);
  for (const name of ["LAWS.bend", "Spec.bend"])
    process.stdout.write(
      `${name} SHA256 ${createHash("sha256")
        .update(readFileSync(join(sourceDirectory, name)))
        .digest("hex")}\n`,
    );
  if (!process.argv.includes("--falsify-only")) {
    const result = spawnSync(join(directory, "bend-check"), [join(sourceDirectory, "PROOF.bend"), "--verdict"], {
      encoding: "utf8",
      timeout: 7000,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ALL PROOFS CHECK/);
    process.stdout.write(`${terminalMutants.length} isolated law-linked proof controls passed\n${result.stdout}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
