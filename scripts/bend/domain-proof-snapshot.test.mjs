import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { prepareConversationCores } from "../quality/bend.mjs";

for (const core of ["admission-core", "response-terminal-core"]) {
  test(`${core}: proof input mutation cannot publish artifacts from a stale proof snapshot`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "balabol-proof-snapshot-test-"));
    const oldPath = process.env.PATH;
    const oldSource = process.env.BEND_BUILD_TEST_SOURCE;
    try {
      const owner = join(temporary, `src/conversation/${core}`);
      mkdirSync(join(owner, "generated"), { recursive: true });
      writeFileSync(join(owner, "core.bend"), "import Base\n\ndef token(n: Nat) -> Nat:\n  n\n");
      writeFileSync(join(owner, "PROOF.bend"), "import core\n");
      for (const name of ["Spec.bend", "LAWS.bend"]) writeFileSync(join(owner, name), "import Base\n");
      writeFileSync(join(owner, "generated/core.mjs"), "previous proved module");
      writeFileSync(
        join(temporary, "bend"),
        `#!/bin/sh
if [ "$1" = version ]; then
  echo 'bend 2.0.36'
  exit 0
fi
case "$1" in
  */PROOF.bend)
    printf '\\n# modified during proof\\n' >> "$BEND_BUILD_TEST_SOURCE"
    echo 'ALL PROOFS CHECK'
    ;;
  *) printf 'export default {}' > "$3" ;;
esac
`,
        { mode: 0o755 },
      );
      process.env.PATH = temporary + delimiter + oldPath;
      process.env.BEND_BUILD_TEST_SOURCE = join(owner, "core.bend");
      assert.throws(() => prepareConversationCores(temporary), /proof inputs changed during preparation/);
      assert.equal(readFileSync(join(owner, "generated/core.mjs"), "utf8"), "previous proved module");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSource === undefined) delete process.env.BEND_BUILD_TEST_SOURCE;
      else process.env.BEND_BUILD_TEST_SOURCE = oldSource;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test(`${core}: missing specification and laws cannot pass the production proof gate`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "balabol-proof-inputs-test-"));
    try {
      const owner = join(temporary, `src/conversation/${core}`);
      mkdirSync(owner, { recursive: true });
      writeFileSync(join(owner, "core.bend"), "import Base\n");
      writeFileSync(join(owner, "PROOF.bend"), "import Base\n");
      assert.throws(() => prepareConversationCores(temporary), /proof input missing: Spec.bend/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
