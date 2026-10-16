import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDomainCore } from "./domain-build.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(directory, ".qualification-"));
try {
  const source = `import Base

type Phase is Data:
  Pending{}
  Complete{}

type State is Data:
  State{operation: Nat, phase: Phase, eligible: Bool}

def initial(operation: Nat) -> State:
  State{operation, Pending{}, True{}}

def preserve(state: State) -> State:
  state
`;
  const corePath = join(temporary, "core.bend");
  writeFileSync(corePath, source);
  buildDomainCore(corePath, temporary);
  const { default: generated } = await import(pathToFileURL(join(temporary, "core.mjs")).href);
  const maximum = 281474976710655n;
  for (const phase of ["Pending", "Complete"])
    for (const eligible of [false, true])
      for (const operation of [0n, 1n, maximum]) {
        const state = Object.freeze({ $: "State", operation, phase: Object.freeze({ $: phase }), eligible });
        assert.deepEqual(generated.preserve(state), state);
      }
  assert.deepEqual(generated.initial(maximum), {
    $: "State",
    operation: maximum,
    phase: { $: "Pending" },
    eligible: true,
  });
  writeFileSync(
    join(temporary, "consumer.mts"),
    `import core, { type State, type Phase } from "./core.mjs";
const phase: Phase = { $: "Complete" };
const state: State = { $: "State", operation: 42n, phase, eligible: false };
const result: State = core.preserve(state);
const initial: State = core.initial(42n);
void result; void initial;
// @ts-expect-error unqualified numeric representation
core.initial(42);
// @ts-expect-error invalid constructor
const wrong: Phase = { $: "Other" };
void wrong;
`,
  );
  const tsc = spawnSync(
    resolve(directory, "../../node_modules/.bin/tsc"),
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      join(temporary, "consumer.mts"),
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  if (tsc.error) throw tsc.error;
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  process.stdout.write(
    "Concrete ADT ABI: constructor, Bool, Nat endpoint, immutable input and generated declarations passed\n",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
