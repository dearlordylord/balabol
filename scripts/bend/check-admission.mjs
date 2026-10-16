import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDomainCore } from "./domain-build.mjs";
import { falsifyAdmission } from "./admission-falsify.mjs";
import { checkMutantProof } from "./admission-proof-controls.mjs";
import { admissionMutants } from "../../src/conversation/admission-core/mutants.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const sourceDirectory = join(root, "src/conversation/admission-core");
const temporary = mkdtempSync(join(directory, ".qualification-"));
try {
  buildDomainCore(join(sourceDirectory, "core.bend"), temporary);
  const { default: core } = await import(pathToFileURL(join(temporary, "core.mjs")).href);
  const cases = falsifyAdmission(core);
  process.stdout.write(`Admission laws: ${cases} concrete transition cases and source-clock boundary cases passed\n`);
  for (const mutant of admissionMutants) {
    const mutantDirectory = join(temporary, mutant.name);
    mkdirSync(mutantDirectory);
    const source = readFileSync(join(sourceDirectory, "core.bend"), "utf8");
    assert.equal(source.split(mutant.from).length, 2, `Mutant target must be unique: ${mutant.name}`);
    writeFileSync(join(mutantDirectory, "core.bend"), source.replace(mutant.from, mutant.to));
    buildDomainCore(join(mutantDirectory, "core.bend"), mutantDirectory);
    const { default: mutated } = await import(pathToFileURL(join(mutantDirectory, "core.mjs")).href);
    assert.throws(
      () => falsifyAdmission(mutated),
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
  process.stdout.write(
    `Admission falsifier controls: ${admissionMutants.length} compiling semantic mutants rejected\n`,
  );
  if (!process.argv.includes("--falsify-only")) {
    process.stdout.write(
      `Admission proof controls: ${admissionMutants.length} law-linked literal counterexamples and isolated proof rejections passed\n`,
    );
    const result = spawnSync(join(directory, "bend-check"), [join(sourceDirectory, "PROOF.bend"), "--verdict"], {
      encoding: "utf8",
      timeout: 7000,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ALL PROOFS CHECK/);
    process.stdout.write(result.stdout);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
