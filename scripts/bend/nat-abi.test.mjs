import assert from "node:assert/strict";
import { test } from "node:test";
import { declarations } from "./nat-abi.mjs";

test("declarations derive the qualified exported name from Bend source", () => {
  assert.match(
    declarations("import Base\n\ndef opaque(n: Nat) -> Nat:\n  n\n"),
    /readonly opaque: \(token: bigint\) => bigint/,
  );
});

test("unsupported foreign types fail closed", () => {
  for (const type of ["String", "Bool", "U32", "List<Data, Nat>"])
    assert.throws(() => declarations(`def token(n: ${type}) -> ${type}:\n  n\n`));
});

test("multiple exports are not silently left undeclared", () => {
  assert.throws(() => declarations("def one(n: Nat) -> Nat:\n  n\ndef two(n: Nat) -> Nat:\n  n\n"));
});

test("unqualified imports and declarations are refused", () => {
  for (const prefix of [
    "import ./other.bend as Other\n",
    "unsafe def hidden() -> Nat:\n  0n\n",
    "type Other is Data:\n  Other{}\n",
  ])
    assert.throws(() => declarations(`${prefix}def token(n: Nat) -> Nat:\n  n\n`));
});

test("the complete fixture grammar rejects trailing constructs and whitespace variants", () => {
  const valid = "import Base\n\ndef token(n: Nat) -> Nat:\n  n\n";
  assert.match(declarations(valid), /readonly token/);
  for (const invalid of [
    valid + "type Other is Data:\n  Other{}\n",
    valid + "\tdef hidden(n: Nat) -> Nat:\n  n\n",
    " \n" + valid,
    valid.replace("def token", "def\ttoken"),
    valid.replace("import Base", "import\tBase"),
    valid.replace("  n\n", "  0n\n"),
    valid.replace("  n\n", "  wrong\n"),
    valid.replace("\n", "\r\n"),
    valid + "\n",
    valid.replace("  n\n", "  n\n# extra\n"),
  ])
    assert.throws(() => declarations(invalid));
});
