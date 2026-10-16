import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function check(wrapper, path, expectedSuccess) {
  const result = spawnSync(wrapper, [path, "--verdict"], { encoding: "utf8", timeout: 7000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Signals are not semantic proof rejection");
  assert.notEqual(result.status, null);
  assert.ok(![124, 137].includes(result.status), "A deadline is not semantic proof rejection");
  const output = result.stdout + result.stderr;
  assert.equal(result.status === 0, expectedSuccess, output);
  assert.match(output, expectedSuccess ? /ALL PROOFS CHECK/ : /SOME PROOFS FAIL/);
  if (!expectedSuccess) assert.doesNotMatch(output, /TODOs found|expected : 'def', 'type' or 'law'|no such file/);
  return output;
}

function lawSection(source, name) {
  const start = source.indexOf(`law ${name}:\n`);
  assert.notEqual(start, -1, `Missing law ${name}`);
  const next = source.indexOf("\n#", start);
  return source.slice(start, next === -1 ? undefined : next).trim();
}

function proofSection(source, name) {
  const marker = `# ---- ${name} ----`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing proof section ${name}`);
  const next = source.indexOf("\n# ----", start + marker.length);
  return source.slice(start, next === -1 ? undefined : next).trim();
}

function instanceOfLaw(law, at) {
  const binders = [...law.matchAll(/^  for \+?([a-zA-Z]+): (.+)$/gm)];
  assert.deepEqual(
    Object.keys(at).sort(),
    binders.map((match) => match[1]).sort(),
    "Literal instance must supply exactly the law binders",
  );
  const substitute = (text) => text.replace(/\b[a-zA-Z]+\b/g, (word) => at[word] ?? word);
  const premises = binders.filter((match) => match[2].startsWith("{"));
  const goal = law.split("\n").at(-1).trim();
  assert.ok(goal.startsWith("{"), "Only equality laws are qualified by this literal generator");
  return `import Base\nimport ./core.bend as Core\nimport ./Spec.bend as Spec\n\n${premises.map((match) => `def premise_${match[1]}() -> ${substitute(match[2])}:\n  ${at[match[1]]}\n`).join("\n")}\ndef instance() -> ${substitute(goal)}:\n  {==}\n`;
}

// Isolate the selected law with its own section. Otherwise a mutant can reject
// an incidental proof structure in an unrelated, still-true law.
export function checkMutantProof({ wrapper, sourceDirectory, mutantDirectory, original, mutant }) {
  const laws = readFileSync(join(sourceDirectory, "LAWS.bend"), "utf8");
  const proof = readFileSync(join(sourceDirectory, "PROOF.bend"), "utf8");
  const spec = readFileSync(join(sourceDirectory, "Spec.bend"), "utf8");
  const selected = lawSection(laws, mutant.law);
  const prefix = proof.slice(0, proof.indexOf("# ----"));
  writeFileSync(
    join(mutantDirectory, "LAWS.bend"),
    `import Base\nimport ./core.bend as Core\nimport ./Spec.bend as Spec\n\n${selected}\n`,
  );
  writeFileSync(join(mutantDirectory, "PROOF.bend"), `${prefix}${proofSection(proof, mutant.law)}\n`);
  writeFileSync(join(mutantDirectory, "Spec.bend"), spec);
  writeFileSync(join(mutantDirectory, "instance.bend"), instanceOfLaw(selected, mutant.at));
  const altered = readFileSync(join(mutantDirectory, "core.bend"), "utf8");
  try {
    writeFileSync(join(mutantDirectory, "core.bend"), original);
    check(wrapper, join(mutantDirectory, "PROOF.bend"), true);
    check(wrapper, join(mutantDirectory, "instance.bend"), true);
    writeFileSync(join(mutantDirectory, "core.bend"), altered);
    check(wrapper, join(mutantDirectory, "instance.bend"), false);
    const rejection = check(wrapper, join(mutantDirectory, "PROOF.bend"), false);
    const location = /Location: ([^\n]+)/.exec(rejection)?.[1];
    assert.ok(location, "Proof rejection must identify its definition");
    const section = proofSection(proof, mutant.law);
    assert.ok(section.includes(`def ${location}(`), `Mutant rejected outside its law section: ${location}`);
  } finally {
    writeFileSync(join(mutantDirectory, "core.bend"), altered);
  }
}
