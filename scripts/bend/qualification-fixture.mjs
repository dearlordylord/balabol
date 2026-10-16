export const core = "import Base\n\ndef token(n: Nat) -> Nat:\n  n\n";
export const law = `import Base
import ./core.bend as Core

# Pure token function preserves its input; host mapping is checked separately.
law token_identity:
  for +n: Nat
  {Core.token(n) == n : Nat}
`;
export const proof = `import Base
import ./LAWS.bend as Laws

def Laws.token_identity(n):
  {==}
`;

export function hostSource() {
  return `import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import generated from "./core.mjs"

const maximumToken = 281474976710655n
class InvalidToken extends Error {
  readonly _tag = "InvalidToken"
}
const Token = Schema.BigInt.check(Schema.makeFilter((value) => value >= 0n && value <= maximumToken))
const decodeToken = (value: unknown) => Schema.decodeUnknownEffect(Token)(value).pipe(
  Effect.mapError((error) => new InvalidToken(String(error)))
)
const token = (input: unknown) => decodeToken(input).pipe(
  Effect.flatMap((value) => Effect.try({
    try: () => generated.token(value),
    catch: (error) => new InvalidToken(String(error))
  })),
  Effect.flatMap(decodeToken)
)
for (const input of [0n, 1n, 42n, 100000n, maximumToken - 1n, maximumToken])
  assert.equal(await Effect.runPromise(token(input)), input)
for (const input of [-1n, maximumToken + 1n, 0, 1.5, NaN, Infinity, "42", null, {}, true]) {
  const result = await Effect.runPromise(token(input).pipe(Effect.result))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure._tag, "InvalidToken")
}
// Exercise enough calls to expose accidental per-token loops at realistic IDs.
for (let index = 0; index < 10000; index++)
  assert.equal(await Effect.runPromise(token(maximumToken)), maximumToken)
process.stdout.write("Node + Effect: validated generated ABI, endpoint and 10,000 calls passed\\n")
`;
}
