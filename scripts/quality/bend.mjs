import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDomainCore } from "../bend/domain-build.mjs";

const cores = ["admission-core", "response-terminal-core"];
function prepareCore(root, core) {
  const owner = `src/conversation/${core}`;
  const source = resolve(root, owner, "core.bend");
  if (!existsSync(source)) return;
  // Prove and compile one immutable input set, including relative proof imports.
  const snapshot = mkdtempSync(resolve(tmpdir(), `balabol-${core}-proof-`));
  const names = ["core.bend", "Spec.bend", "LAWS.bend", "PROOF.bend"];
  for (const name of names)
    if (!existsSync(resolve(root, owner, name))) {
      rmSync(snapshot, { recursive: true, force: true });
      throw new Error(`${core} proof input missing: ${name}`);
    }
  try {
    for (const name of names) cpSync(resolve(root, owner, name), resolve(snapshot, name));
    const proof = spawnSync(
      fileURLToPath(new URL("../bend/bend-check", import.meta.url)),
      [resolve(snapshot, "PROOF.bend"), "--verdict"],
      { cwd: snapshot, encoding: "utf8", timeout: 15000 },
    );
    if (proof.error) throw proof.error;
    if (proof.status !== 0 || !proof.stdout.includes("ALL PROOFS CHECK"))
      throw new Error(`${core} proof gate failed:\n${proof.stdout}${proof.stderr}`);
    buildDomainCore(resolve(snapshot, "core.bend"), resolve(snapshot, "generated"));
    for (const name of names)
      if (readFileSync(resolve(root, owner, name), "utf8") !== readFileSync(resolve(snapshot, name), "utf8"))
        throw new Error(`${core} proof inputs changed during preparation; refusing stale artifacts`);
    const generated = resolve(root, owner, "generated");
    mkdirSync(generated, { recursive: true });
    for (const name of ["core.mjs", "core.d.mts"])
      cpSync(resolve(snapshot, "generated", name), resolve(generated, name));
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function copyCore(root, core) {
  const owner = `src/conversation/${core}`;
  const source = resolve(root, owner, "generated/core.mjs");
  if (!existsSync(resolve(root, owner, "core.bend"))) return;
  const destination = resolve(root, `dist/conversation/${core}/generated`);
  mkdirSync(destination, { recursive: true });
  cpSync(source, resolve(destination, "core.mjs"));
}

export function prepareConversationCores(root) {
  for (const core of cores) prepareCore(root, core);
}

export function copyConversationCores(root) {
  for (const core of cores) copyCore(root, core);
}
