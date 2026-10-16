import assert from "node:assert/strict";

// A deliberately narrow ABI generator. Unsupported source must fail rather than
// silently produce declarations that suggest a foreign type was qualified.
export function declarations(source) {
  const signature = /^import Base\n\ndef ([a-z][a-z_]*)\(([a-z][a-z_]*): Nat\) -> Nat:\n  \2\n$/.exec(source);
  assert.ok(signature, "Unsupported qualification fixture: expected the complete Base + Nat identity source");
  return `declare const core: { readonly ${signature[1]}: (token: bigint) => bigint };\nexport default core;\n`;
}
