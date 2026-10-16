import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import { command } from "./commands.mjs";

const Versions = Schema.Record(Schema.String, Schema.String);
const Manifest = Schema.Struct({
  devDependencies: Versions,
  pnpm: Schema.Struct({ patchedDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
});
const Installed = Schema.Struct({ version: Schema.String });
const Tree = Schema.suspend(() =>
  Schema.Struct({
    version: Schema.optionalKey(Schema.String),
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Tree)),
    devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Tree)),
    optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Tree)),
  }),
);
const read = (path, schema) => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(readFileSync(path, "utf8"));

export const checkCohort = (root) => {
  const manifest = read(resolve(root, "package.json"), Manifest);
  const expected = {
    effect: "4.0.5",
    "@effect/platform-node": "4.0.5",
    "@effect/vitest": "4.0.5",
    "@effect/tsgo": "0.36.4",
    vitest: "5.0.1",
    "@vitest/coverage-v8": "5.0.1",
    "@typescript/native": "npm:typescript@7.0.2",
  };
  for (const [name, version] of Object.entries(expected)) {
    if (manifest.devDependencies?.[name] !== version) throw new Error(`Cohort manifest mismatch: ${name}`);
    const installed = read(resolve(root, "node_modules", name, "package.json"), Installed);
    if (installed.version !== version.replace("npm:typescript@", ""))
      throw new Error(`Cohort installed mismatch: ${name}`);
  }
  // Plain memory extensions may be patched; the entire Effect cohort remains pristine.
  const patches = Object.keys(manifest.pnpm?.patchedDependencies ?? {});
  if (patches.some((name) => name === "effect" || name.startsWith("effect@") || name.startsWith("@effect/")))
    throw new Error("Effect cohort must remain unpatched");
  const shared = read(
    resolve(
      dirname(realpathSync(resolve(root, "node_modules/@effect/platform-node"))),
      "platform-node-shared/package.json",
    ),
    Installed,
  );
  if (shared.version !== "4.0.5") throw new Error("Effect transitive cohort mismatch");
  const tree = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Tree)))(
    command(root, "pnpm", ["list", "--depth", "Infinity", "--json"], true),
  );
  const visit = (entry) => {
    for (const [name, dependency] of Object.entries({
      ...entry.dependencies,
      ...entry.devDependencies,
      ...entry.optionalDependencies,
    })) {
      if (name === "effect" || name.startsWith("@effect/")) {
        const required = name.startsWith("@effect/tsgo") ? "0.36.4" : "4.0.5";
        if (["@effect/cli", "@effect/platform"].includes(name) || dependency.version !== required)
          throw new Error(`Incompatible Effect dependency: ${name}@${dependency.version}`);
      }
      visit(dependency);
    }
  };
  for (const entry of tree) visit(entry);
  if (command(root, "effect-tsgo", ["--version"], true).trim() !== "tsgo v0.36.4")
    throw new Error("Effect diagnostics executable version mismatch");
};
