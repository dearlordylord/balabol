import assert from "node:assert/strict";
import { test } from "node:test";
import { domainDeclarations } from "./domain-abi.mjs";

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

test("concrete ADT fields and all exports derive from compiled Bend source", () => {
  const declarations = domainDeclarations(source);
  assert.match(declarations, /readonly \$: "Pending"/);
  assert.match(declarations, /readonly operation: bigint/);
  assert.match(declarations, /readonly phase: Phase/);
  assert.match(declarations, /readonly eligible: boolean/);
  assert.match(declarations, /readonly initial: \(operation: bigint\) => State/);
  assert.match(declarations, /readonly preserve: \(state: State\) => State/);
});

test("unqualified ABI forms fail closed", () => {
  for (const invalid of [
    source.replace("operation: Nat", "operation: String"),
    source.replace("state: State", "~state: State"),
    source.replace("type Phase is Data", "type Phase<A> is Data"),
    source + "foreign def injected() -> Nat:\n  0n\n",
    source.replace("import Base", "import ./external.bend as External"),
    source.replace("Complete{}", "Complete{value: List<Data, Nat>}"),
    source.replace("Complete{}", "Complete{value: Maybe<Nat>}"),
    source.replace("def preserve", "unsafe def preserve"),
    source.replace("  state\n", '  import "./external.js"\n'),
  ])
    assert.throws(() => domainDeclarations(invalid));
});
