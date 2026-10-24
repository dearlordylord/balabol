import assert from "node:assert/strict";
import { constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkLocalResources,
  dictionaryReadiness,
  localRequirements,
  providerDescription,
  providerEnvironment,
} from "./dev-voice.mjs";

test("ordinary launch preserves fake defaults and does not acquire any local speech dependencies", () => {
  const source = { BALABOL_DATABASE: "personal.sqlite" };
  const selected = providerEnvironment([], source);
  assert.deepEqual(selected, source);
  assert.notEqual(selected, source);
  assert.deepEqual(localRequirements(selected), []);
  assert.equal(
    providerDescription(selected),
    "answers=fake, memory summaries=fake, recognition=fake, synthesis=fake, speech activity=fake",
  );
});

test("real opt-in selects subscription models and Soniox speech while check preserves the same selection", () => {
  const selected = providerEnvironment(["--real"], {});
  assert.deepEqual(selected, {
    BALABOL_ANSWER_PROVIDER: "subscription",
    BALABOL_SUMMARY_PROVIDER: "subscription",
    BALABOL_RECOGNITION_PROVIDER: "soniox",
    BALABOL_SYNTHESIS_PROVIDER: "soniox",
    BALABOL_ACTIVITY_PROVIDER: "silero",
    BALABOL_VOICE_DIAGNOSTICS: "1",
    BALABOL_ANSWER_MODEL: "gpt-6.1-sol",
    BALABOL_SUMMARY_MODEL: "gpt-6-luna",
  });
  assert.deepEqual(providerEnvironment(["--real", "--check"], {}), selected);
  assert.deepEqual(
    localRequirements(selected).map((item) => item.mode),
    [constants.R_OK],
  );
});

test("explicit provider, model and VAD overrides survive real opt-in without mutating the caller", () => {
  const source = {
    BALABOL_ANSWER_PROVIDER: "fake",
    BALABOL_SUMMARY_MODEL: "custom-luna",
    BALABOL_VAD_MODEL: "/local/vad.onnx",
  };
  const selected = providerEnvironment(["--real"], source);
  assert.equal(selected.BALABOL_ANSWER_PROVIDER, "fake");
  assert.equal(selected.BALABOL_ANSWER_MODEL, undefined);
  assert.equal(selected.BALABOL_SUMMARY_MODEL, "custom-luna");
  assert.deepEqual(
    localRequirements(selected).map((item) => item.path),
    ["/local/vad.onnx"],
  );
  assert.match(providerDescription(selected), /^answers=fake, memory summaries=subscription/);
  assert.equal(source.BALABOL_SUMMARY_PROVIDER, undefined);
});

test("real voice keeps an explicit diagnostics opt-out", () => {
  const source = { BALABOL_VOICE_DIAGNOSTICS: "0" };
  assert.equal(providerEnvironment(["--real"], source).BALABOL_VOICE_DIAGNOSTICS, "0");
  assert.deepEqual(source, { BALABOL_VOICE_DIAGNOSTICS: "0" });
});

test("unknown options fail selection before prerequisite commands can run", () => {
  assert.throws(() => providerEnvironment(["--reel"], {}), /Unknown option/);
});

test("read-only speech checks require readable VAD files without invoking their contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-launch-check-"));
  try {
    const artifact = join(directory, "artifact");
    writeFileSync(artifact, "fixture weights", { mode: 0o600 });
    const environment = providerEnvironment(["--real", "--check"], {
      BALABOL_VAD_MODEL: artifact,
      SONIOX_API_KEY: "fixture-only",
    });
    assert.doesNotThrow(() => checkLocalResources(environment));
    assert.throws(() => checkLocalResources({ ...environment, BALABOL_VAD_MODEL: directory }), /Silero VAD weights/);
    assert.throws(
      () => checkLocalResources({ ...environment, BALABOL_VAD_MODEL: join(directory, "missing") }),
      /Silero VAD weights/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a fresh checkout reports missing optional dictionary data with the recovery command", () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-no-dictionary-"));
  try {
    const path = join(directory, "missing.sqlite");
    const status = dictionaryReadiness({ ...process.env, BALABOL_DICTIONARY_PATH: path });
    assert.match(status, /Dictionary: UNAVAILABLE/);
    assert.match(status, /pnpm prepare:dictionary/);
    assert.match(status, /Ordinary chat remains available/);
    assert.throws(() => statSync(path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Soniox recognition requires a key and the default speech classifier", () => {
  const environment = { BALABOL_RECOGNITION_PROVIDER: "soniox", BALABOL_ACTIVITY_PROVIDER: "fake" };
  assert.throws(() => checkLocalResources(environment), /SONIOX_API_KEY/);
  assert.doesNotThrow(() => checkLocalResources({ ...environment, SONIOX_API_KEY: "fixture-only" }));
  assert.deepEqual(localRequirements(environment), []);
});

test("Soniox synthesis requires a key and no installed Apple voices or helper", () => {
  const environment = { BALABOL_SYNTHESIS_PROVIDER: "soniox" };
  for (const SONIOX_API_KEY of [undefined, "", " "]) {
    assert.throws(() => checkLocalResources({ ...environment, SONIOX_API_KEY }), /SONIOX_API_KEY/);
  }
  assert.doesNotThrow(() => checkLocalResources({ ...environment, SONIOX_API_KEY: "fixture-only" }));
  assert.deepEqual(localRequirements(environment), []);
});

test("backend stderr preserves audit health and suppresses secrets across chunks and huge lines", async () => {
  const { backendDiagnostics, backendExitDiagnostic } = await import("./backend-diagnostics.mjs");
  const messages = [];
  const sink = backendDiagnostics((message) => messages.push(message));
  for (const part of [
    "Operation audit wri",
    "te failed\n",
    "secret-token\n",
    "x".repeat(100000),
    "\n",
    "Operation audit queue overflow\n",
  ])
    sink.write(Buffer.from(part));
  sink.finish();
  assert.deepEqual(messages, [
    "Operation audit write failed",
    "Voice backend emitted an unclassified diagnostic; raw contents suppressed.",
    "Operation audit queue overflow",
  ]);
  assert.equal(backendExitDiagnostic(null, "SIGKILL"), "Voice backend exited: code=none, signal=SIGKILL.");
  assert.equal(backendExitDiagnostic(1, "private-value"), "Voice backend exited: code=1, signal=other.");
});

test("backend diagnostics are bounded and retain final shutdown and bootstrap categories", async () => {
  const { backendDiagnostics } = await import("./backend-diagnostics.mjs");
  const messages = [];
  const sink = backendDiagnostics((message) => messages.push(message));
  sink.write(
    Buffer.from(
      "Balabol backend configuration failed\nBalabol backend runtime failed\nOperation audit record too large\nOperation audit shutdown deadline exceeded; pending=7",
    ),
  );
  sink.finish();
  assert.deepEqual(messages, [
    "Balabol backend configuration failed",
    "Balabol backend runtime failed",
    "Operation audit record too large",
    "Operation audit shutdown deadline exceeded; pending=7",
  ]);
  for (let index = 0; index < 1000; index += 1) sink.write(Buffer.from("Operation audit write failed\n"));
  assert.equal(messages.length, 129);
  assert.equal(messages.at(-1), "Voice backend diagnostics suppressed after 128 records.");
});

test("backend pipe retains shutdown evidence before process close without exposing raw stderr", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { backendDiagnostics, backendExitDiagnostic } = await import("./backend-diagnostics.mjs");
  const messages = [];
  const sink = backendDiagnostics((message) => messages.push(message));
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('private-secret\\nOperation audit write failed\\n'); process.exitCode = 7"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.on("data", (data) => sink.write(data));
  child.stderr.once("end", () => sink.finish());
  const [code, signal] = await once(child, "close");
  assert.deepEqual(messages, [
    "Voice backend emitted an unclassified diagnostic; raw contents suppressed.",
    "Operation audit write failed",
  ]);
  assert.equal(backendExitDiagnostic(code, signal), "Voice backend exited: code=7, signal=none.");
});

test("a throwing diagnostics reporter cannot crash or prevent draining child stderr", async () => {
  const { backendDiagnostics } = await import("./backend-diagnostics.mjs");
  let attempts = 0;
  const sink = backendDiagnostics(() => {
    attempts += 1;
    throw new Error("reporter unavailable");
  });
  assert.doesNotThrow(() => sink.write(Buffer.from("Operation audit write failed\n")));
  assert.doesNotThrow(() => sink.write(Buffer.from("Balabol backend runtime failed")));
  assert.doesNotThrow(() => sink.finish());
  assert.equal(attempts, 2);
});
