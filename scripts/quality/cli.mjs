import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { checkArchitecture } from "./architecture.mjs";
import { checkCohort } from "./cohort.mjs";
import { command } from "./commands.mjs";
import { sourceFiles } from "./files.mjs";

const [gate, option, directory] = process.argv.slice(2);
const root = resolve(option === "--root" ? directory : ".");
const product = sourceFiles(resolve(root, "src")).filter(
  (file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
);
const typescript = [
  ...sourceFiles(resolve(root, "src")),
  ...sourceFiles(resolve(root, "test")),
  ...sourceFiles(resolve(root, "scripts")),
  ...readdirSync(root)
    .filter((name) => name.endsWith(".config.ts"))
    .map((name) => resolve(root, name)),
];
const run = (executable, args) => command(root, executable, args);
const absent = () => process.stdout.write("No product source: skipped product-only gate; NOT product acceptance.\n");
const actions = {
  cohort: () => checkCohort(root),
  architecture: () => checkArchitecture(root, sourceFiles(resolve(root, "src"))),
  build: () => (product.length ? run("tsc", ["-p", "tsconfig.build.json"]) : absent()),
  compiler: () => run("tsc", ["-p", "tsconfig.json", "--noEmit"]),
  effect: () =>
    run("effect-tsgo", ["diagnostics", "--project", "tsconfig.json", "--strict", "--severity", "error,warning"]),
  cycles: () =>
    product.length
      ? run("dpdm", [
          "--no-warning",
          "--no-tree",
          "--no-progress",
          "--exit-code",
          "circular:1",
          "--transform",
          "src/**/*.ts",
        ])
      : absent(),
  complexity: () => (product.length ? run("oxlint", ["-c", "oxlint.complexity.json", ...product]) : absent()),
  lint: () =>
    typescript.length ? run("oxlint", ["-c", ".oxlintrc.json", "--deny-warnings", ...typescript]) : absent(),
  duplication: () => (product.length ? run("jscpd", ["--silent", "src"]) : absent()),
  format: () => run("dprint", ["check", "--allow-no-files"]),
  behavior: () => {
    if (!product.length) return absent();
    if (!typescript.some((file) => file.endsWith(".test.ts")))
      throw new Error("Product source exists without behavioral tests");
    rmSync(resolve(root, "coverage/coverage-final.json"), { force: true });
    run("vitest", ["run", "--coverage"]);
    actions.crap();
  },
  crap: () => {
    if (!product.length) return absent();
    if (!existsSync(resolve(root, "coverage/coverage-final.json")))
      throw new Error("CRAP requires a fresh coverage/coverage-final.json; run the behavior gate");
    run("crap4ts", [
      "--coverage",
      "coverage/coverage-final.json",
      "--coverage-format",
      "istanbul-json",
      "--threshold",
      "8",
      "--no-report-only",
      "--project-root",
      root,
      ...product,
    ]);
  },
  secrets: () => run("gitleaks", ["dir", "--redact", "--ignore-gitleaks-allow", "--no-banner", "."]),
};
try {
  if (gate === "all") {
    actions.secrets();
    for (const name of [
      "cohort",
      "build",
      "compiler",
      "effect",
      "architecture",
      "cycles",
      "complexity",
      "lint",
      "duplication",
      "format",
      "behavior",
    ]) {
      process.stdout.write(`Quality gate: ${name}\n`);
      actions[name]();
    }
    if (!product.length)
      process.stdout.write("Harness configuration passed; product acceptance remains pending (no product source).\n");
  } else {
    if (!Object.hasOwn(actions, gate)) throw new Error(`Unknown quality gate: ${gate}`);
    actions[gate]();
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
