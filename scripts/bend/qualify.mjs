import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { declarations } from "./nat-abi.mjs";
import { core, law, proof, hostSource } from "./qualification-fixture.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const supportedBend = "bend 2.0.36";

function run(command, args, expectedSuccess = true) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 15000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "A signal is not a semantic proof rejection");
  assert.notEqual(result.status, null, "Missing checker exit status");
  const output = result.stdout + result.stderr;
  assert.equal(result.status === 0, expectedSuccess, `${command}: ${output}`);
  return output;
}

assert.equal(process.versions.node.split(".")[0], "24", "Qualification requires Node 24");
assert.equal(run("bend", ["version"]).trim(), supportedBend, "Unqualified Bend version");
assert.throws(() => declarations("def token(n: String) -> String:\n  n\n"));
const temporary = mkdtempSync(join(directory, ".qualification-"));
try {
  const path = (name) => join(temporary, name);
  const write = (name, content) => writeFileSync(path(name), content);
  const check = (name, success = true) => run(join(directory, "bend-check"), [path(name), "--verdict"], success);
  write("core.bend", core);
  write("LAWS.bend", law);
  // Falsify the identity claim at boundary representatives before its proof.
  write(
    "instances.bend",
    `import Base\nimport ./core.bend as Core\n${[...Array.from({ length: 256 }, (_, index) => index), 100000, 4294967295].map((n, i) => `def instance_${i}() -> {Core.token(${n}n) == ${n}n : Nat}:\n  {==}\n`).join("\n")}`,
  );
  assert.match(check("instances.bend"), /ALL PROOFS CHECK/);
  write("PROOF.bend", proof);
  assert.match(check("PROOF.bend"), /ALL PROOFS CHECK/);
  write("false.bend", "import Base\n\ndef false_claim() -> {0n == 1n : Nat}:\n  {==}\n");
  assert.match(check("false.bend", false), /SOME PROOFS FAIL/);
  // A semantic mutant must compile; syntax/type rejection is not evidence.
  write("core.bend", core.replace("  n\n", "  0n\n"));
  assert.match(check("core.bend"), /ALL PROOFS CHECK/);
  assert.match(check("instances.bend", false), /SOME PROOFS FAIL/);
  assert.match(check("PROOF.bend", false), /SOME PROOFS FAIL/);
  write("core.bend", core);
  run("bend", [path("core.bend"), "-o", path("core.mjs")]);
  write("core.d.mts", declarations(readFileSync(path("core.bend"), "utf8")));
  write("host.mts", hostSource());
  run(join(root, "node_modules/.bin/tsc"), [
    "--ignoreConfig",
    "--types",
    "node",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    path("host.mts"),
  ]);
  process.stdout.write(run(process.execPath, [path("host.mts")]));
  process.stdout.write(
    `${supportedBend}; universal identity proof, false-claim and compiling-mutant controls passed\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
