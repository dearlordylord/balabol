import { join } from "node:path";
import { acceptance } from "./acceptance-tools.mjs";

// Manual only: run without concurrent Swift builds or source edits.
acceptance("output", ({ directory, run, mutant }) => {
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
        marker: failure ? /CONFORMANCE_DIVERGENCE/ : /Executed [1-9][0-9]* tests?/,
        environment: { BALABOL_QUINT_TRACE_DIR: directory },
      },
    );
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
      join(directory, `${prefix}-{test}-{seq}.itf.json`),
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
  mutant("terminal-evidence gate", "ios/Sources/Voice/VoiceOutputTransition.swift", "&& !selectedTerminal", "", () =>
    swift(true),
  );
  mutant(
    "terminal reactivation",
    "ios/Sources/Voice/VoiceOutputTransition.swift",
    "[.delivered, .interrupted, .failed].contains(current.status)",
    "false",
    () => swift(true),
  );
  swift();
});
