import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Manual evidence and exact restoration shared by the two client protocol checks. */
export const acceptance = (name, action) => {
  const directory = mkdtempSync(join(tmpdir(), `balabol-${name}-conformance-`));
  let sequence = 0;
  const run = (command, args, { failure = false, marker, environment = {} } = {}) => {
    const result = spawnSync(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const path = join(directory, `${++sequence}-${command}.log`);
    writeFileSync(path, log);
    if (result.error || result.signal || (failure ? result.status === 0 : result.status !== 0)) {
      throw new Error(
        `${command} did not satisfy ${failure ? "rejection" : "success"}: ${result.error ?? result.status}; ${path}\n${log.slice(-4000)}`,
      );
    }
    if (marker && !marker.test(log)) throw new Error(`Missing expected evidence ${marker}: ${path}`);
    console.log(`${failure ? "Rejected control" : "Passed"}: ${command} ${args.join(" ")} (${path})`);
    return log;
  };
  const mutant = (label, relativePath, before, after, check) => {
    const path = join(root, relativePath);
    const original = readFileSync(path);
    const source = original.toString();
    if (source.split(before).length !== 2) throw new Error(`Ambiguous mutation site: ${label}`);
    try {
      writeFileSync(path, source.replace(before, after));
      check();
    } finally {
      writeFileSync(path, original);
      if (hash(readFileSync(path)) !== hash(original)) throw new Error(`Failed exact restoration: ${label}`);
      console.log(`Restored ${label}: SHA256 ${hash(original)}`);
    }
  };
  try {
    action({ directory, run, mutant });
    console.log(`${name} acceptance passed. Synthetic traces and logs: ${directory}`);
  } catch (error) {
    console.error(error);
    console.error(`Acceptance failed; synthetic evidence retained: ${directory}`);
    process.exitCode = 1;
  }
};
