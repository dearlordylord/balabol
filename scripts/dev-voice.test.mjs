import assert from "node:assert/strict";
import { constants, mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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

test("real opt-in selects subscription models and local speech while check preserves the same selection", () => {
  const selected = providerEnvironment(["--real"], {});
  assert.deepEqual(selected, {
    BALABOL_ANSWER_PROVIDER: "subscription",
    BALABOL_SUMMARY_PROVIDER: "subscription",
    BALABOL_RECOGNITION_PROVIDER: "qwen3-asr",
    BALABOL_SYNTHESIS_PROVIDER: "apple",
    BALABOL_ACTIVITY_PROVIDER: "silero",
    BALABOL_VOICE_DIAGNOSTICS: "1",
    BALABOL_ANSWER_MODEL: "gpt-6.1-sol",
    BALABOL_SUMMARY_MODEL: "gpt-6-luna",
  });
  assert.deepEqual(providerEnvironment(["--real", "--check"], {}), selected);
  assert.deepEqual(
    localRequirements(selected).map((item) => item.mode),
    [constants.X_OK, constants.R_OK, constants.R_OK, constants.X_OK, constants.X_OK, constants.R_OK],
  );
  assert.equal(localRequirements(selected, false).length, 5);
});

test("explicit provider, model and local executable overrides survive real opt-in without mutating the caller", () => {
  const source = {
    BALABOL_ANSWER_PROVIDER: "fake",
    BALABOL_SUMMARY_MODEL: "custom-luna",
    BALABOL_QWEN_PYTHON_PATH: "/local/python",
    BALABOL_QWEN_HELPER_PATH: "/local/qwen.py",
    BALABOL_QWEN_MODEL: "/local/qwen-model",
    BALABOL_APPLE_SPEECH_EXECUTABLE: "/local/apple",
    BALABOL_FFMPEG_EXECUTABLE: "/local/ffmpeg",
    BALABOL_VAD_MODEL: "/local/vad.onnx",
  };
  const selected = providerEnvironment(["--real"], source);
  assert.equal(selected.BALABOL_ANSWER_PROVIDER, "fake");
  assert.equal(selected.BALABOL_ANSWER_MODEL, undefined);
  assert.equal(selected.BALABOL_SUMMARY_MODEL, "custom-luna");
  assert.deepEqual(
    localRequirements(selected).map((item) => item.path),
    [
      "/local/python",
      "/local/qwen.py",
      "/local/qwen-model/config.json",
      "/local/ffmpeg",
      "/local/apple",
      "/local/vad.onnx",
    ],
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

test("read-only speech checks require readable files and executables without invoking their contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "balabol-launch-check-"));
  try {
    const executable = join(directory, "executable");
    const model = join(directory, "qwen-model");
    mkdirSync(model);
    writeFileSync(join(model, "config.json"), "{}");
    const artifact = join(directory, "artifact");
    writeFileSync(executable, "This file must never be executed by prerequisite checking", { mode: 0o700 });
    writeFileSync(artifact, "fixture weights", { mode: 0o600 });
    const environment = providerEnvironment(["--real", "--check"], {
      BALABOL_QWEN_PYTHON_PATH: executable,
      BALABOL_QWEN_HELPER_PATH: artifact,
      BALABOL_QWEN_MODEL: model,
      BALABOL_APPLE_SPEECH_EXECUTABLE: executable,
      BALABOL_FFMPEG_EXECUTABLE: executable,
      BALABOL_VAD_MODEL: artifact,
    });
    assert.doesNotThrow(() => checkLocalResources(environment));
    assert.throws(
      () => checkLocalResources({ ...environment, BALABOL_QWEN_MODEL: directory }),
      /Qwen model configuration/,
    );
    assert.throws(
      () => checkLocalResources({ ...environment, BALABOL_APPLE_SPEECH_EXECUTABLE: artifact }),
      /Apple speech helper/,
    );
    assert.throws(
      () => checkLocalResources({ ...environment, BALABOL_QWEN_MODEL: join(directory, "missing") }),
      /Qwen model configuration/,
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
