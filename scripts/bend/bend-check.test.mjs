import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const wrapper = fileURLToPath(new URL("./bend-check", import.meta.url));
const live = (pid) => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
};

test("proof deadline kills a TERM-ignoring compiler and its subprocess", { timeout: 10000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "balabol-proof-deadline-"));
  const parentFile = join(temporary, "parent");
  const childFile = join(temporary, "child");
  const pids = [];
  try {
    writeFileSync(
      join(temporary, "bend"),
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > "$BEND_TEST_PARENT"
sleep 120 &
printf '%s' "$!" > "$BEND_TEST_CHILD"
wait
`,
      { mode: 0o755 },
    );
    const started = performance.now();
    const result = spawnSync(wrapper, ["ignored.bend", "--verdict"], {
      env: {
        ...process.env,
        PATH: temporary + delimiter + process.env.PATH,
        BEND_TEST_PARENT: parentFile,
        BEND_TEST_CHILD: childFile,
      },
      encoding: "utf8",
      timeout: 8000,
    });
    pids.push(Number(readFileSync(parentFile, "utf8")), Number(readFileSync(childFile, "utf8")));
    assert.equal(result.error, undefined, "the wrapper itself must enforce the deadline");
    assert.equal(result.status, 137);
    assert.ok(performance.now() - started < 7500);
    assert.match(result.stderr, /exceeded five seconds/);
    for (let attempt = 0; attempt < 20 && pids.some(live); attempt++) await setTimeout(25);
    assert.ok(
      pids.every((pid) => !live(pid)),
      "compiler process tree must have no live remainder",
    );
  } finally {
    for (const pid of pids) if (live(pid)) process.kill(pid, "SIGKILL");
    rmSync(temporary, { recursive: true, force: true });
  }
});
