import assert from "node:assert/strict";
import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLocalResources, localRequirements, providerDescription, providerEnvironment } from "./dev-voice.mjs";

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
    BALABOL_RECOGNITION_PROVIDER: "whisper",
    BALABOL_SYNTHESIS_PROVIDER: "apple",
    BALABOL_ACTIVITY_PROVIDER: "silero",
    BALABOL_VOICE_DIAGNOSTICS: "1",
    BALABOL_ANSWER_MODEL: "gpt-6.1-sol",
    BALABOL_SUMMARY_MODEL: "gpt-6-luna",
  });
  assert.deepEqual(providerEnvironment(["--real", "--check"], {}), selected);
  assert.deepEqual(
    localRequirements(selected).map((item) => item.mode),
    [constants.X_OK, constants.R_OK, constants.X_OK, constants.X_OK, constants.R_OK],
  );
  assert.equal(localRequirements(selected, false).length, 4);
});

test("explicit provider, model and local executable overrides survive real opt-in without mutating the caller", () => {
  const source = {
    BALABOL_ANSWER_PROVIDER: "fake",
    BALABOL_SUMMARY_MODEL: "custom-luna",
    BALABOL_WHISPER_EXECUTABLE: "/local/whisper",
    BALABOL_WHISPER_MODEL: "/local/small.bin",
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
    ["/local/whisper", "/local/small.bin", "/local/ffmpeg", "/local/apple", "/local/vad.onnx"],
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
    const model = join(directory, "small.bin");
    writeFileSync(executable, "This file must never be executed by prerequisite checking", { mode: 0o700 });
    writeFileSync(model, "fixture weights", { mode: 0o600 });
    const environment = providerEnvironment(["--real", "--check"], {
      BALABOL_WHISPER_EXECUTABLE: executable,
      BALABOL_WHISPER_MODEL: model,
      BALABOL_APPLE_SPEECH_EXECUTABLE: executable,
      BALABOL_FFMPEG_EXECUTABLE: executable,
      BALABOL_VAD_MODEL: model,
    });
    assert.doesNotThrow(() => checkLocalResources(environment));
    assert.throws(() => checkLocalResources({ ...environment, BALABOL_WHISPER_MODEL: directory }), /whisper weights/);
    assert.throws(
      () => checkLocalResources({ ...environment, BALABOL_APPLE_SPEECH_EXECUTABLE: model }),
      /Apple speech helper/,
    );
    assert.throws(
      () => checkLocalResources({ ...environment, BALABOL_WHISPER_MODEL: join(directory, "missing") }),
      /whisper weights/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
