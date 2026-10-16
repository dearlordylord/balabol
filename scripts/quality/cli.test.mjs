import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const fixture = (files, action) => {
  const root = mkdtempSync(join(tmpdir(), "balabol-quality-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const owners = JSON.stringify({
  owners: [{ name: "conversation", root: "src/conversation", entry: "index.ts", dependencies: [] }],
});
const run = (root, gate) =>
  spawnSync(process.execPath, ["scripts/quality/cli.mjs", gate, "--root", root], { encoding: "utf8" });

test("architecture gate rejects a type-only cycle through its public CLI", () => {
  fixture(
    {
      "quality-owners.json": owners,
      "src/conversation/index.ts": 'export type { A } from "./a.js"',
      "src/conversation/a.ts": 'import type { B } from "./b.js"; export type A = B',
      "src/conversation/b.ts": 'import type { A } from "./a.js"; export type B = A',
    },
    (root) => {
      const result = run(root, "architecture");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cycle/);
    },
  );
});

const configured = (files, action) =>
  fixture(files, (root) => {
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync("scripts/oxlint-project-plugin.mjs", join(root, "scripts/oxlint-project-plugin.mjs"));
    for (const name of [
      "tsconfig.json",
      "tsconfig.build.json",
      "vitest.config.ts",
      "vitest.slow.config.ts",
      "dprint.json",
      "oxlint.complexity.json",
      ".oxlintrc.json",
      ".jscpd.json",
      "package.json",
    ])
      copyFileSync(name, join(root, name));
    return action(root);
  });
const assertGate = (files, gate, expected, pattern) =>
  configured(files, (root) => {
    const result = run(root, gate);
    assert.equal(result.status === 0, expected, result.stdout + result.stderr);
    if (pattern) assert.match(result.stdout + result.stderr, pattern);
  });

const twoOwners = JSON.stringify({
  owners: [
    { name: "conversation", root: "src/conversation", entry: "index.ts", dependencies: ["memory"] },
    { name: "memory", root: "src/memory", entry: "index.ts", dependencies: [] },
  ],
});

test("architecture accepts public and local edges and ignores import text in comments", () =>
  assertGate(
    {
      "quality-owners.json": twoOwners,
      "src/conversation/index.ts": 'import { value } from "../memory/index.js"; export { value }; // import("missing")',
      "src/memory/index.ts": 'export { value } from "./internal.js"',
      "src/memory/internal.ts": "export const value = 1",
    },
    "architecture",
    true,
  ));

for (const [name, files, pattern] of [
  [
    "lazy transitive cycle",
    {
      "src/conversation/index.ts": 'export const load = () => import("./a.js")',
      "src/conversation/a.ts": 'export type A = import("./index.js").A',
    },
    /cycle/,
  ],
  [
    "private cross-owner entry",
    {
      "src/conversation/index.ts": 'import type { A } from "../memory/internal.js"',
      "src/memory/index.ts": "export {}",
      "src/memory/internal.ts": "export type A = string",
    },
    /Private entrypoint/,
  ],
  [
    "computed import",
    { "src/conversation/index.ts": 'const name = "./a.js"; export const load = () => import(name)' },
    /Computed dependency/,
  ],
  ["unknown owner", { "src/unknown/index.ts": "export {}" }, /Undeclared owner/],
  [
    "unresolved target",
    { "src/conversation/index.ts": 'export type A = import("./missing.js").A' },
    /Unresolved dependency/,
  ],
])
  test(`architecture rejects ${name}`, () =>
    assertGate({ "quality-owners.json": twoOwners, ...files }, "architecture", false, pattern));

test("compiler accepts a strict typed source", () =>
  assertGate({ "src/conversation/index.ts": 'export const value: string = "ok"' }, "compiler", true));
test("compiler rejects unchecked indexed access", () =>
  assertGate(
    { "src/conversation/index.ts": 'export const value: string = ["ok"][1]' },
    "compiler",
    false,
    /undefined/,
  ));
test("Effect diagnostics accept a valid program", () =>
  assertGate(
    { "src/conversation/index.ts": 'import { Effect } from "effect"; export const value = Effect.succeed("ok")' },
    "effect",
    true,
  ));
test("Effect diagnostics reject discarded Effects", () =>
  assertGate(
    {
      "src/conversation/index.ts":
        'import { Effect } from "effect"; export const value = Effect.gen(function*() { Effect.succeed("lost") })',
    },
    "effect",
    false,
  ));

for (const [name, code, pattern] of [
  ["cast", "export const value = JSON.parse('1') as number", /Type assertions/],
  ["clock", "export const value = Date.now()", /Date.now/],
  ["performance clock", "export const value = performance.now()", /Date.now/],
  ["mock", 'import { vi as renamed } from "vitest"; renamed.mock("x")', /Test mocks/],
  ["spy", 'import { vi } from "vitest"; vi.spyOn(Math, "random")', /Test mocks/],
  ["property placement", 'import fc from "fast-check"; export const value = fc.string()', /Property-based/],
  ["schema alias", 'import { Schema as S } from "effect"; export const value = S.String', /alias Schema/],
  ["floating promise", "export const value = () => { Promise.resolve(1) }", /floating-promises/],
])
  test(`lint rejects ${name}`, () =>
    assertGate({ "test/example.test.ts": code, "src/conversation/index.ts": "export {}" }, "lint", false, pattern));

const propertyFixture = {
  "src/index.ts": "export const increment = (n: number) => n >= 0 ? n + 1 : 0\n",
  "test/example.property.test.ts":
    'import { expect, it } from "@effect/vitest"; import { Schema } from "effect"; import fc from "fast-check"; import { increment } from "../src/index.js"; it.prop("known examples", [Schema.Literals([-2, 2])], ([input]) => { expect(increment(input)).toBe(input === 2 ? 3 : 0) }, { arbitrary: { seed: 42 } }); it("fast-check example", () => { fc.assert(fc.property(fc.constant({input: 2, expected: 3}), example => { expect(increment(example.input)).toBe(example.expected) }), { seed: 42 }) })',
};
test("pinned cohort typechecks and executes correctly placed Schema and fast-check properties", () => {
  for (const gate of ["compiler", "lint", "behavior"]) assertGate(propertyFixture, gate, true);
});

test("complexity rejects nine independent branches", () =>
  assertGate(
    {
      "src/conversation/index.ts":
        "export function value(n: number) { let result = 0; " +
        Array.from({ length: 9 }, (_, i) => `if(n > ${i}) result++;`).join(" ") +
        " return result }",
    },
    "complexity",
    false,
    /complexity/,
  ));
test("line count rejects 421 code lines", () =>
  assertGate(
    { "src/conversation/index.ts": Array.from({ length: 421 }, (_, i) => `export const value${i} = 1`).join("\n") },
    "lint",
    false,
    /max-lines/,
  ));
test("format rejects unformatted TypeScript", () =>
  assertGate({ "src/conversation/index.ts": "export const   value=1;" }, "format", false));
test("build emits a valid source and rejects invalid types", () => {
  assertGate({ "src/conversation/index.ts": 'export const value = "ok"' }, "build", true);
  assertGate({ "src/conversation/index.ts": 'export const value: number = "wrong"' }, "build", false);
});
test("behavior requires tests for product source", () =>
  assertGate(
    { "src/conversation/index.ts": 'export const value = "ok"' },
    "behavior",
    false,
    /without behavioral tests/,
  ));
test("empty product is explicitly pending", () => assertGate({}, "behavior", true, /NOT product acceptance/));

test("architecture resolves aliases and refuses private alias targets", () =>
  configured(
    {
      "quality-owners.json": twoOwners,
      "src/conversation/index.ts": 'import type { A } from "@memory/internal"; export type B = A',
      "src/memory/index.ts": "export {}",
      "src/memory/internal.ts": "export type A = string",
    },
    (root) => {
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            paths: { "@memory/*": ["./src/memory/*"] },
            moduleResolution: "NodeNext",
            module: "NodeNext",
          },
        }),
      );
      const result = run(root, "architecture");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Private entrypoint/);
    },
  ));
test("architecture rejects ambiguous owners", () =>
  assertGate(
    {
      "quality-owners.json": JSON.stringify({
        owners: [
          { name: "x", root: "src", entry: "index.ts", dependencies: [] },
          { name: "x", root: "src/memory", entry: "index.ts", dependencies: [] },
        ],
      }),
    },
    "architecture",
    false,
    /Duplicate|Overlapping/,
  ));
test("architecture follows local source closure beyond initial glob", () =>
  configured(
    {
      "quality-owners.json": JSON.stringify({
        owners: [
          { name: "conversation", root: "src/conversation", entry: "index.ts", dependencies: ["outside"] },
          { name: "outside", root: "outside", entry: "index.ts", dependencies: ["conversation"] },
        ],
      }),
      "src/conversation/index.ts": 'export type A = import("../../outside/index.js").B',
      "outside/index.ts": 'export type B = import("../src/conversation/index.js").A',
    },
    (root) => {
      const result = run(root, "architecture");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cycle/);
    },
  ));
test("lint rejects imported-module monkey-patching", () =>
  assertGate(
    { "test/example.test.ts": 'import * as MathModule from "node:os"; MathModule.platform = () => "darwin"' },
    "lint",
    false,
    /monkey-patching/,
  ));
test("dpdm rejects a runtime import cycle", () =>
  assertGate(
    {
      "src/a.ts": 'import { b } from "./b.js"; export const a = () => b()',
      "src/b.ts": 'import { a } from "./a.js"; export const b = () => a()',
    },
    "cycles",
    false,
    /circular/i,
  ));
test("duplication rejects copied production blocks", () => {
  const body = Array.from({ length: 20 }, (_, i) => `  const value${i} = n + ${i}`).join("\n");
  const source = `export function calculate(n: number) {\n${body}\n  return value0\n}`;
  assertGate({ "src/a.ts": source, "src/b.ts": source }, "duplication", false, /threshold/i);
});
const increment = "export const increment = (n: number) => n >= 0 ? n + 1 : 0\n";
const positiveTests =
  'import { expect, it } from "@effect/vitest"\nimport { increment } from "../src/index.js"\nit("increments positive input", () => { expect(increment(2)).toBe(3) })\nit("clamps negative input", () => { expect(increment(-2)).toBe(0) })\n';
test("CRAP accepts fully exercised source with Effect test runner", () =>
  assertGate({ "src/index.ts": increment, "test/index.test.ts": positiveTests }, "behavior", true, /100/));
test("CRAP accepts low-risk source with incomplete coverage", () =>
  assertGate(
    {
      "src/index.ts": "export function increment(n: number) { if (n < 0) return 0; return n + 1 }",
      "test/index.test.ts": positiveTests.split('it("clamps')[0],
    },
    "behavior",
    true,
    /crap4ts report/,
  ));

test("CRAP rejects risky source with incomplete coverage", () =>
  assertGate(
    {
      "src/index.ts":
        "export function increment(n: number) { if (n < -5) return 0; if (n < -4) return 0; if (n < -3) return 0; if (n < -2) return 1; if (n < -1) return 2; if (n < 0) return 3; return n + 1 }",
      "test/index.test.ts": positiveTests.split('it("clamps')[0],
    },
    "behavior",
    false,
    /crap4ts report/,
  ));
test("CRAP rejects missing coverage evidence", () =>
  assertGate({ "src/index.ts": increment }, "crap", false, /requires a fresh coverage/));

test("behavior rejects stale coverage when the runner produces no JSON artifact", () =>
  configured({ "src/index.ts": increment, "test/index.test.ts": positiveTests }, (root) => {
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage/coverage-final.json"), "{}");
    const config = readFileSync(join(root, "vitest.config.ts"), "utf8");
    writeFileSync(join(root, "vitest.config.ts"), config.replace('["text-summary", "json"]', '["text-summary"]'));
    const result = run(root, "behavior");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /requires a fresh coverage/);
  }));

test("lint rejects destructured mock APIs", () =>
  assertGate(
    { "test/example.test.ts": 'import { vi } from "vitest"; const { mock: replace } = vi; replace("x")' },
    "lint",
    false,
    /Test mocks/,
  ));
test("lint rejects global monkey-patching", () =>
  assertGate({ "test/example.test.ts": "Math.random = () => 1" }, "lint", false, /monkey-patching/));

test("secret scan accepts safe input and rejects a synthetic token", () => {
  assertGate({ "safe.txt": "No credentials here" }, "secrets", true);
  const secret = "gh" + "p_" + "7JzaK64LxPwQ2yVfT8sR9mB3nC5dE6hG1uA0";
  assertGate({ "secret.txt": `token=${secret}` }, "secrets", false, /leaks found/i);
});

test("actual commit hook scans secrets before formatting and rejects secret history on push", () =>
  configured({ "safe.md": "# Safe fixture\n" }, (root) => {
    cpSync(resolve("scripts/quality"), join(root, "scripts/quality"), { recursive: true });
    cpSync(resolve("scripts/bend"), join(root, "scripts/bend"), { recursive: true });
    for (const name of [".gitleaks.toml", ".prettierignore", ".prettierrc.json"]) copyFileSync(name, join(root, name));
    const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.name", "Quality Fixture"]).status, 0);
    assert.equal(git(["config", "user.email", "quality@example.invalid"]).status, 0);
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    for (const name of ["pre-commit", "pre-push"]) {
      writeFileSync(join(root, ".git/hooks", name), "#!/bin/sh\n" + readFileSync(join(".husky", name), "utf8"), {
        mode: 0o755,
      });
    }
    assert.equal(git(["add", "safe.md"]).status, 0);
    const safe = git(["commit", "--quiet", "-m", "Safe fixture"]);
    assert.equal(safe.status, 0, safe.stdout + safe.stderr);
    const token = "gh" + "p_" + "7JzaK64LxPwQ2yVfT8sR9mB3nC5dE6hG1uA0";
    writeFileSync(join(root, "unsafe.md"), `token=${token}\n`);
    assert.equal(git(["add", "unsafe.md"]).status, 0);
    const unsafe = git(["commit", "--quiet", "-m", "Must reject"]);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /leaks found/i);
    assert.doesNotMatch(unsafe.stdout + unsafe.stderr, /lint-staged|typecheck:tsc/);
    assert.equal(
      git(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Synthetic unsafe history for push self-check"])
        .status,
      0,
    );
    const push = spawnSync("sh", [".git/hooks/pre-push"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /leaks found/i);
  }));

test("complexity accepts the exact maximum of eight", () =>
  assertGate(
    {
      "src/index.ts":
        "export function choose(n: number) { let value = 0; " +
        Array.from({ length: 7 }, (_, i) => `if(n > ${i}) value++;`).join(" ") +
        " return value }",
    },
    "complexity",
    true,
  ));
test("line count accepts exactly 420 nonblank code lines", () =>
  assertGate(
    { "src/index.ts": Array.from({ length: 420 }, (_, i) => `export const value${i} = 1`).join("\n") },
    "lint",
    true,
  ));
test("architecture rejects a symbolic source escape", () =>
  configured({ "quality-owners.json": owners }, (root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync(resolve("scripts/quality"), join(root, "src/conversation"));
    const result = run(root, "architecture");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Symbolic source/);
  }));
test("cohort detects a declared version drift", () =>
  configured({}, (root) => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.devDependencies.effect = "4.0.4";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    const result = run(root, "cohort");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cohort manifest mismatch/);
  }));
test("cohort allows a plain memory patch while rejecting every Effect patch", () => {
  configured({}, (root) => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.pnpm.patchedDependencies = { "@firfi/unii@0.1.0": "patches/unii.patch" };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    let result = run(root, "cohort");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const dependency of [
      "effect",
      "effect@4.0.5",
      "@effect/platform-node@4.0.5",
      "@effect/platform-node-shared@4.0.5",
      "@effect/tsgo@0.36.4",
    ]) {
      manifest.pnpm.patchedDependencies[dependency] = "patches/forbidden.patch";
      writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
      result = run(root, "cohort");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Effect cohort must remain unpatched/);
      delete manifest.pnpm.patchedDependencies[dependency];
    }
  });
});
test("CLI rejects unknown gates instead of accepting object prototype names", () =>
  assertGate({}, "toString", false, /Unknown quality gate/));

test("architecture rejects aliased module loaders", () =>
  assertGate(
    {
      "quality-owners.json": owners,
      "src/conversation/index.ts": 'const load = require; export const value = load("./private.js")',
    },
    "architecture",
    false,
    /module loaders/,
  ));
test("architecture rejects loader factories", () =>
  assertGate(
    {
      "quality-owners.json": owners,
      "src/conversation/index.ts":
        'import { createRequire } from "node:module"; export const load = createRequire(import.meta.url)',
    },
    "architecture",
    false,
    /Module-loader factories/,
  ));

test("lint rejects property generators in production source", () =>
  assertGate(
    { "src/conversation/index.ts": 'import fc from "fast-check"; export const arbitrary = fc.string()' },
    "lint",
    false,
    /Property-based/,
  ));
test("lint rejects extracted mock functions", () =>
  assertGate(
    { "test/extracted.test.ts": 'import { vi } from "vitest"; const make = vi.fn; export const fake = make()' },
    "lint",
    false,
    /Test mocks/,
  ));
test("lint rejects global aliases used for monkey-patching", () =>
  assertGate({ "test/alias.test.ts": "const math = Math; math.random = () => 1" }, "lint", false, /monkey-patching/));
test("lint rejects imported aliases used for monkey-patching", () =>
  assertGate(
    { "test/alias.test.ts": 'import * as os from "node:os"; const system = os; system.platform = () => "darwin"' },
    "lint",
    false,
    /monkey-patching/,
  ));
test("architecture rejects type-only import-equals private edges", () =>
  assertGate(
    {
      "quality-owners.json": twoOwners,
      "src/conversation/index.ts": 'import type Private = require("../memory/internal.js"); export type A = Private.A',
      "src/memory/index.ts": "export {}",
      "src/memory/internal.ts": "export type A = string",
    },
    "architecture",
    false,
    /Private entrypoint/,
  ));
test("architecture rejects type-only import-equals cycles", () =>
  assertGate(
    {
      "quality-owners.json": owners,
      "src/conversation/index.ts": 'import type A = require("./a.js"); export type B = A.B',
      "src/conversation/a.ts": 'import type B = require("./index.js"); export type A = B.B',
    },
    "architecture",
    false,
    /cycle/,
  ));

test("lint permits ordinary local object mutation and aliasing", () =>
  assertGate(
    { "src/index.ts": "const original = { value: 0 }; const alias = original; alias.value = 1; export { original }" },
    "lint",
    true,
  ));
test("architecture accepts an import-equals edge through a public entrypoint", () =>
  assertGate(
    {
      "quality-owners.json": twoOwners,
      "src/conversation/index.ts": 'import type Memory = require("../memory/index.js"); export type A = Memory.A',
      "src/memory/index.ts": "export type A = string",
    },
    "architecture",
    true,
  ));

test("lint permits ordinary prop and property methods", () =>
  assertGate(
    {
      "src/index.ts":
        'const reader = { prop: () => "ok", property: () => "value", asyncProperty: () => "other" }; export const value = reader.prop() + reader.property() + reader.asyncProperty()',
    },
    "lint",
    true,
  ));
test("lint rejects aliased Effect property runner calls outside property files", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { it as test } from "@effect/vitest"; import { Schema } from "effect"; const runner = test; runner.prop("example", [Schema.String], ([value]) => { if (value.length < 0) throw new Error("invalid") })',
    },
    "lint",
    false,
    /Property-based tests/,
  ));
test("lint rejects destructured Effect property runner calls outside property files", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { it } from "@effect/vitest"; import { Schema } from "effect"; const { prop: check } = it; check("example", [Schema.String], ([value]) => { if (value.length < 0) throw new Error("invalid") })',
    },
    "lint",
    false,
    /Property-based tests/,
  ));

test("lint rejects namespace Effect property runner calls outside property files", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import * as testApi from "@effect/vitest"; import { Effect, Schema } from "effect"; testApi.it.effect.prop("example", [Schema.String], () => Effect.void)',
    },
    "lint",
    false,
    /Property-based tests/,
  ));
test("lint rejects imported property runner functions outside property files", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { prop as check } from "@effect/vitest"; import { Schema } from "effect"; check("example", [Schema.String], () => undefined)',
    },
    "lint",
    false,
    /Property-based tests/,
  ));

test("lint rejects misplaced properties inside the public layer callback", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { layer } from "@effect/vitest"; import { Layer, Schema } from "effect"; layer(Layer.empty)((runner) => { runner.prop("example", [Schema.String], () => undefined) })',
    },
    "lint",
    false,
    /Property-based tests/,
  ));
test("lint rejects misplaced properties inside named it.layer callbacks", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { it } from "@effect/vitest"; import { Layer, Schema } from "effect"; const suite = it.layer(Layer.empty); suite("named", (runner) => { const { prop: check } = runner; check("example", [Schema.String], () => undefined) })',
    },
    "lint",
    false,
    /Property-based tests/,
  ));
test("lint rejects misplaced properties inside namespace and nested layer callbacks", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import * as testApi from "@effect/vitest"; import { Layer, Schema } from "effect"; testApi.layer(Layer.empty)((outer) => { outer.layer(Layer.empty)((inner) => { inner.prop("example", [Schema.String], () => undefined) }) })',
    },
    "lint",
    false,
    /Property-based tests/,
  ));

test("lint preserves ordinary Effect layer dependency-injection tests", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { expect, layer } from "@effect/vitest"; import { Effect, Layer } from "effect"; layer(Layer.empty)("scope", (runner) => { runner.effect("example", () => Effect.gen(function*() { const value = yield* Effect.succeed("ok"); expect(value).toBe("ok") })) })',
    },
    "lint",
    true,
  ));
test("lint preserves unrelated layer and prop methods", () =>
  assertGate(
    {
      "src/index.ts":
        'const reader = { prop: () => "ok" }; const adapter = { layer: () => (callback: (value: typeof reader) => string) => callback(reader) }; export const value = adapter.layer()((local) => local.prop())',
    },
    "lint",
    true,
  ));
test("lint fails closed for ambiguous Effect layer callback references", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { layer } from "@effect/vitest"; import { Layer } from "effect"; const callback = () => undefined; layer(Layer.empty)(callback)',
    },
    "lint",
    false,
    /inline Effect layer callback/,
  ));
const layeredProperties = {
  "src/index.ts": "export const increment = (n: number) => n >= 0 ? n + 1 : 0\n",
  "test/example.property.test.ts":
    'import { expect, it, layer } from "@effect/vitest"; import * as testApi from "@effect/vitest"; import { Effect, Layer, Schema } from "effect"; import { increment } from "../src/index.js"; layer(Layer.empty)((runner) => { runner.prop("direct", [Schema.Literals([-2, 2])], ([input]) => { expect(increment(input)).toBe(input === 2 ? 3 : 0) }, { arbitrary: { seed: 42 } }) }); it.layer(Layer.empty)("named", (runner) => { runner.effect.prop("effect", [Schema.Literals([-2, 2])], ([input]) => Effect.sync(() => { expect(increment(input)).toBe(input === 2 ? 3 : 0) }), { arbitrary: { seed: 42 } }) }); testApi.layer(Layer.empty)((outer) => { outer.layer(Layer.empty)((inner) => { inner.prop("nested", [Schema.Literals([-2, 2])], ([input]) => { expect(increment(input)).toBe(input === 2 ? 3 : 0) }, { arbitrary: { seed: 42 } }) }) })',
};
test("public layer property APIs typecheck and execute in property files", () => {
  for (const gate of ["compiler", "lint", "behavior"]) assertGate(layeredProperties, gate, true);
});

test("lint fails closed for computed Layer runner destructuring", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { layer } from "@effect/vitest"; import { Layer, Schema } from "effect"; const key = "prop"; layer(Layer.empty)(({ [key]: check }) => { check("example", [Schema.String], () => undefined) })',
    },
    "lint",
    false,
    /literal destructured/,
  ));
test("lint fails closed for rest Layer runner parameters", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { layer } from "@effect/vitest"; import { Layer, Schema } from "effect"; layer(Layer.empty)((...runners) => { runners[0]?.prop("example", [Schema.String], () => undefined) })',
    },
    "lint",
    false,
    /simple named/,
  ));

test("Layer runner provenance does not leak into an unrelated outer object", () =>
  assertGate(
    {
      "test/example.test.ts":
        'import { layer } from "@effect/vitest"; import { Effect, Layer } from "effect"; const runner = { prop: () => "ordinary" }; layer(Layer.empty)((runner) => { runner.effect("example", () => Effect.void) }); export const value = runner.prop()',
    },
    "lint",
    true,
  ));

test("fast behavior excludes slow tests and explicit slow invocation excludes fast tests", () => {
  configured(
    {
      "src/index.ts": increment,
      "test/index.test.ts": positiveTests,
      "test/index.slow.test.ts":
        'import { it } from "vitest"; it("manual slow sentinel", () => { throw new Error("SLOW_SENTINEL") })',
    },
    (root) => {
      const fast = run(root, "behavior");
      assert.equal(fast.status, 0, fast.stdout + fast.stderr);
      writeFileSync(join(root, "test/index.test.ts"), 'throw new Error("FAST_SENTINEL")');
      const slow = spawnSync(
        process.execPath,
        [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.slow.config.ts"],
        { cwd: root, encoding: "utf8" },
      );
      assert.notEqual(slow.status, 0);
      assert.match(slow.stdout + slow.stderr, /SLOW_SENTINEL/);
      assert.doesNotMatch(slow.stdout + slow.stderr, /FAST_SENTINEL/);
    },
  );
});

test("build ships the proved native core and rejects a changed unproved implementation", () => {
  configured(
    {
      "src/conversation/index.ts":
        'import core from "./admission-core/generated/core.mjs"; export const token = core.token;',
      "src/conversation/admission-core/core.bend": "import Base\n\ndef token(n: Nat) -> Nat:\n  n\n",
      "src/conversation/admission-core/Spec.bend": "import Base\n",
      "src/conversation/admission-core/LAWS.bend":
        "import Base\nimport ./core.bend as Core\n\nlaw identity:\n  for +n: Nat\n  {Core.token(n) == n : Nat}\n",
      "src/conversation/admission-core/PROOF.bend":
        "import Base\nimport ./LAWS.bend as Laws\n\ndef Laws.identity(n):\n  {==}\n",
    },
    (root) => {
      const built = run(root, "build");
      assert.equal(built.status, 0, built.stdout + built.stderr);
      rmSync(join(root, "src/conversation/admission-core/generated"), { recursive: true });
      const executed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import assert from "node:assert/strict"; import { token } from ${JSON.stringify(join(root, "dist/conversation/index.js"))}; assert.equal(token(281474976710655n), 281474976710655n);`,
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(executed.status, 0, executed.stdout + executed.stderr);
      writeFileSync(
        join(root, "src/conversation/admission-core/core.bend"),
        "import Base\n\ndef token(n: Nat) -> Nat:\n  0n\n",
      );
      const rejected = run(root, "compiler");
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Admission proof gate failed/);
    },
  );
});
