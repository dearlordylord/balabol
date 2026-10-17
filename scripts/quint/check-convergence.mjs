import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { acceptance } from "./acceptance-tools.mjs";

if (process.argv.length === 3 && process.argv[2] === "--controls") {
  acceptance("convergence-controls", ({ run, mutant }) => {
    const check = (failure = false) =>
      run("node", ["scripts/quint/check-convergence.mjs"], {
        failure,
        marker: failure ? /Timed out: canonical terminal via production snapshot/ : /Convergence boundary passed/,
      });
    check();
    mutant(
      "real HTTP terminal evidence gate",
      "ios/Sources/Voice/VoiceOutputTransition.swift",
      "&& !selectedTerminal",
      "",
      () => check(true),
    );
    check();
  });
  process.exit(process.exitCode ?? 0);
}

// Manual integration acceptance: a separate process keeps HTTP alive during Swift.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(join(tmpdir(), "balabol-convergence-boundary-"));
const children = new Set();
const launch = (command, args, environment = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      resolve({ code, signal, output });
    });
  });
  // Register immediately: an early host exit must not become an unhandled rejection.
  done.catch(() => {});
  return { child, done, output: () => output };
};
const bounded = async (promise, milliseconds, description) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const loopbackOrigin = (value) => {
  if (typeof value !== "string") throw new Error("Missing fixture origin");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== value) {
    throw new Error("Fixture must expose an ephemeral loopback HTTP origin");
  }
  return value;
};
const stop = async () => {
  const active = [...children];
  for (const child of active) child.kill("SIGTERM");
  await Promise.all(
    active.map(
      (child) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(1));
  });
}
let host;
let swift;
let passed = false;
try {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/quint/check-convergence.mjs");
  host = launch(process.execPath, ["--experimental-transform-types", "test/voice-convergence-host.ts"]);
  const lines = createInterface({ input: host.child.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      // Effect's ordinary startup diagnostics may precede the readiness object.
      if (!line.startsWith("{")) return;
      try {
        const value = JSON.parse(line);
        resolve({ origin: loopbackOrigin(value.origin), controlOrigin: loopbackOrigin(value.controlOrigin) });
      } catch (error) {
        reject(error);
      }
    });
  });
  const endpoint = await bounded(
    Promise.race([ready, host.done.then(() => Promise.reject(new Error("Fixture exited before readiness")))]),
    30_000,
    "Fixture readiness",
  );
  swift = launch(
    "swift",
    [
      "test",
      "--package-path",
      "ios",
      "--scratch-path",
      "/tmp/balabol-swift-build",
      "--skip-update",
      "--filter",
      "VoiceConvergenceBoundaryTests",
    ],
    { BALABOL_CONVERGENCE_ORIGIN: endpoint.origin, BALABOL_CONVERGENCE_CONTROL_ORIGIN: endpoint.controlOrigin },
  );
  const result = await bounded(
    Promise.race([
      swift.done,
      host.done.then(() => Promise.reject(new Error("Fixture exited during Swift acceptance"))),
    ]),
    180_000,
    "Swift convergence acceptance",
  );
  if (
    result.code !== 0 ||
    result.signal ||
    !result.output.includes("CONVERGENCE_BOUNDARY_PASSED") ||
    /Test Case .* skipped/.test(result.output)
  ) {
    throw new Error(
      `Swift convergence acceptance failed: ${result.code ?? result.signal}\n${result.output.slice(-6000)}`,
    );
  }
  passed = true;
} catch (error) {
  console.error(error);
  console.error(`Acceptance failed; synthetic evidence: ${directory}`);
  process.exitCode = 1;
} finally {
  await stop();
  if (host) writeFileSync(join(directory, "host.log"), host.output());
  if (swift) writeFileSync(join(directory, "swift.log"), swift.output());
  if (passed) {
    const shutdown = await host.done;
    if (shutdown.code !== 0 || shutdown.signal) {
      console.error(`Fixture cleanup failed: ${shutdown.code ?? shutdown.signal}; ${directory}`);
      process.exitCode = 1;
    } else {
      console.log(`Convergence boundary passed. Synthetic evidence: ${directory}`);
    }
  }
}
