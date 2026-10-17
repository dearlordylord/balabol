import { join } from "node:path";
import { acceptance } from "./acceptance-tools.mjs";

// Manual only: run without concurrent Swift builds or source edits.
acceptance("lifecycle", ({ directory, run, mutant }) => {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/quint/check-lifecycle.mjs");
  const version = run("quint", ["--version"]).trim();
  if (version !== "0.31.0") throw new Error(`Qualify Quint 0.31.0 before running; found ${version}`);
  run("quint", ["typecheck", "quint-specs/VoiceLifecycle.qnt"]);
  run("quint", [
    "test",
    "quint-specs/VoiceLifecycleTest.qnt",
    "--main",
    "VoiceLifecycleTest",
    "--seed",
    "62",
    "--max-samples",
    "1",
    "--match",
    ".*Test",
    "--out-itf",
    join(directory, "lifecycle-{test}-{seq}.itf.json"),
  ]);
  const swift = (filter, failure = false) =>
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
        filter,
      ],
      {
        failure,
        marker: failure ? /CONFORMANCE_DIVERGENCE/ : /Executed [1-9][0-9]* tests?/,
        environment: { BALABOL_QUINT_TRACE_DIR: directory },
      },
    );
  const conformance = () => swift("VoiceLifecycleConformanceTests");
  conformance();
  swift("VoiceViewModelTests");
  mutant(
    "composed terminal-evidence gate",
    "ios/Sources/Voice/VoiceOutputTransition.swift",
    "&& !selectedTerminal",
    "",
    () => swift("VoiceLifecycleConformanceTests", true),
  );
  mutant(
    "composed terminal reactivation",
    "ios/Sources/Voice/VoiceOutputTransition.swift",
    "[.delivered, .interrupted, .failed].contains(current.status)",
    "false",
    () => swift("VoiceLifecycleConformanceTests", true),
  );
  conformance();
});
