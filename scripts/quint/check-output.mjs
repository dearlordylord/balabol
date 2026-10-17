import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Manual acceptance only: never run source mutations beside another Swift build.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = mkdtempSync(join(tmpdir(), "balabol-output-conformance-"));
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
  const path = join(output, `${++sequence}-${command}.log`);
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
const swift = (failure = false) =>
  run(
    "swift",
    [
      "test",
      "--package-path",
      "ios",
      "--scratch-path",
      "/tmp/balabol-swift-build",
      "--skip-update",
      "--filter",
      "VoiceOutputConformanceTests|VoicePreparationConformanceTests",
    ],
    {
      failure,
      marker: failure ? /CONFORMANCE_DIVERGENCE/ : /Executed [1-9][0-9]* tests/,
      environment: { BALABOL_QUINT_TRACE_DIR: output },
    },
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mutant = (name, before, after) => {
  const path = join(root, "ios/Sources/Voice/VoiceOutputTransition.swift");
  const original = readFileSync(path);
  const source = original.toString();
  if (source.split(before).length !== 2) throw new Error(`Ambiguous mutation site: ${name}`);
  try {
    writeFileSync(path, source.replace(before, after));
    swift(true);
  } finally {
    writeFileSync(path, original);
    if (hash(readFileSync(path)) !== hash(original)) throw new Error(`Failed exact restoration: ${name}`);
    console.log(`Restored ${name}: SHA256 ${hash(original)}`);
  }
};

try {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/quint/check-output.mjs");
  const version = run("quint", ["--version"]).trim();
  if (version !== "0.31.0") throw new Error(`Qualify Quint 0.31.0 before running; found ${version}`);
  for (const [name, prefix] of [
    ["VoiceOutput", "output"],
    ["VoicePreparation", "preparation"],
  ]) {
    run("quint", ["typecheck", `quint-specs/${name}.qnt`]);
    run("quint", [
      "test",
      `quint-specs/${name}Test.qnt`,
      "--main",
      `${name}Test`,
      "--seed",
      "61",
      "--max-samples",
      "1",
      "--match",
      ".*Test",
      "--out-itf",
      join(output, `${prefix}-{test}-{seq}.itf.json`),
    ]);
  }
  for (const main of ["VoiceOutputGateMutant", "VoiceOutputReactivationMutant"]) {
    run(
      "quint",
      [
        "run",
        "quint-specs/VoiceOutput.qnt",
        "--main",
        main,
        "--invariant",
        "safety",
        "--step",
        "deterministicMutantStep",
        "--seed",
        "61",
        "--max-samples",
        "1",
        "--max-steps",
        "4",
      ],
      { failure: true, marker: /\[violation\]|Invariant[^\n]*(?:violated|violation)/i },
    );
  }
  swift();
  mutant("terminal-evidence gate", "&& !selectedTerminal", "");
  mutant("terminal reactivation", "[.delivered, .interrupted, .failed].contains(current.status)", "false");
  swift();
  console.log(`Output conformance acceptance passed. Synthetic traces and logs: ${output}`);
} catch (error) {
  console.error(error);
  console.error(`Acceptance failed; synthetic evidence retained: ${output}`);
  process.exitCode = 1;
}
