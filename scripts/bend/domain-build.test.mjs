import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { buildDomainCore } from "./domain-build.mjs";

test("source mutation during compilation cannot publish a stale module/declaration pair", () => {
  const temporary = mkdtempSync(join(tmpdir(), "balabol-bend-snapshot-test-"));
  const oldPath = process.env.PATH;
  const oldSource = process.env.BEND_BUILD_TEST_SOURCE;
  try {
    const source = join(temporary, "core.bend");
    const output = join(temporary, "generated");
    mkdirSync(output);
    writeFileSync(source, "import Base\n\ndef token(n: Nat) -> Nat:\n  n\n");
    writeFileSync(join(output, "core.mjs"), "previous module");
    writeFileSync(join(output, "core.d.mts"), "previous declarations");
    writeFileSync(
      join(temporary, "bend"),
      `#!/bin/sh
if [ "$1" = version ]; then
  echo 'bend 2.0.36'
  exit 0
fi
printf '\\n# changed during compile\\n' >> "$BEND_BUILD_TEST_SOURCE"
printf 'export default {}' > "$3"
`,
      { mode: 0o755 },
    );
    process.env.PATH = temporary + delimiter + oldPath;
    process.env.BEND_BUILD_TEST_SOURCE = source;
    assert.throws(() => buildDomainCore(source, output), /source changed during compilation/);
    assert.equal(readFileSync(join(output, "core.mjs"), "utf8"), "previous module");
    assert.equal(readFileSync(join(output, "core.d.mts"), "utf8"), "previous declarations");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldSource === undefined) delete process.env.BEND_BUILD_TEST_SOURCE;
    else process.env.BEND_BUILD_TEST_SOURCE = oldSource;
    rmSync(temporary, { recursive: true, force: true });
  }
});
