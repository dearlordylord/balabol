import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";

// Task-specific experiment: never invoked by CI, hooks or normal application startup.
const endpoint = "https://api.openai.com/v1/responses";
const answerModel = "gpt-6.1-sol";
const summaryModel = "gpt-6-luna";
const Event = Schema.Struct({ type: Schema.String });
const OutputItem = Schema.Struct({ item: Schema.Struct({ type: Schema.String }) });
const Delta = Schema.Struct({ type: Schema.Literal("response.output_text.delta"), delta: Schema.String });
const Completed = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.Struct({ status: Schema.Literal("completed") }),
});
const JsonError = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const decode = Schema.decodeUnknownSync;
const knownProviderCodes = new Set([
  "insufficient_quota",
  "rate_limit_exceeded",
  "usage_limit_reached",
  "quota_exceeded",
  "invalid_api_key",
  "invalid_token",
  "model_not_found",
  "permission_denied",
  "invalid_request_error",
  "unsupported_parameter",
  "invalid_value",
  "unsupported_value",
  "server_error",
  "access_denied",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "subscription_sharing_user_unavailable",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]);
const ProviderError = Schema.Struct({ code: Schema.optional(Schema.String), param: Schema.optional(Schema.String) });
const FailedEvent = Schema.Struct({ response: Schema.Struct({ error: ProviderError }) });
const IncompleteEvent = Schema.Struct({
  response: Schema.Struct({ incomplete_details: Schema.Struct({ reason: Schema.String }) }),
});
const parameterNames = new Set([
  "model",
  "input",
  "instructions",
  "store",
  "stream",
  "temperature",
  "max_output_tokens",
  "tools",
  "previous_response_id",
]);
function terminalFailure(type, parsed) {
  failureObservation = { code: type };
  try {
    if (type === "response.incomplete") {
      const reason = decode(IncompleteEvent)(parsed).response.incomplete_details.reason;
      if (["max_output_tokens", "content_filter"].includes(reason)) failureObservation.reason = reason;
    } else {
      const error =
        type === "response.failed" ? decode(FailedEvent)(parsed).response.error : decode(ProviderError)(parsed);
      if (knownProviderCodes.has(error.code)) failureObservation.providerCode = error.code;
      if (parameterNames.has(error.param)) failureObservation.parameter = error.param;
    }
  } catch {
    /* Invalid or unexpected terminal details remain undisclosed. */
  }
  throw new Error("qualification-stopped");
}
function nonStream(text) {
  let code = "non-sse-body";
  if (text.trimStart().startsWith("{")) {
    try {
      const candidate = decode(JsonError)(JSON.parse(text)).error.code;
      if (knownProviderCodes.has(candidate)) code = `provider-${candidate}`;
    } catch {
      /* Never expose raw JSON/schema errors. */
    }
  }
  failureObservation = { ...failureObservation, code };
  throw new Error("qualification-stopped");
}
const failureCodes = new Set([
  "premature-eof",
  "total-byte-cap",
  "frame-byte-cap",
  "text-cap",
  "cleanup-deadline",
  "unexpected-output-item",
  "provider-terminal-or-tool",
  "empty-output",
  "deadline",
  "required-model-absent",
  "experiment-cap",
  "http-auth",
  "http-quota",
  "http-provider",
  "content-type",
  "invalid-stream-or-transport",
  "unexpected-terminal",
  "synthetic-context-check",
]);
let failureObservation = { code: "qualification-or-setup-failed" };
const fail = (code) => {
  failureObservation = { code: failureCodes.has(code) ? code : "qualification-or-setup-failed" };
  throw new Error("qualification-stopped");
};
const requestBody = (model, prompt) => ({
  model,
  store: false,
  stream: true,
  instructions:
    "Use only explicitly supplied text. You have no tools or external context. Follow the requested output format.",
  input: [{ role: "user", content: prompt }],
});

async function consume(body, controller, cancel, deadline, started = performance.now()) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  let text = "";
  let firstDelta;
  let completed = false;
  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) {
        if (pending.trim()) nonStream(pending);
        fail("premature-eof");
      }
      bytes += value.byteLength;
      if (bytes > 1048576) fail("total-byte-cap");
      pending += decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (Buffer.byteLength(frame) > 65536) fail("frame-byte-cap");
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        const event = decode(Event)(parsed);
        if (
          event.type === "response.output_item.added" &&
          !["message", "reasoning"].includes(decode(OutputItem)(parsed).item.type)
        )
          fail("unexpected-output-item");
        if (event.type === "response.output_text.delta") {
          const delta = decode(Delta)(parsed).delta;
          firstDelta ??= Math.round(performance.now() - started);
          text += delta;
          if (text.length > 4096) fail("text-cap");
          if (cancel && delta.length > 0) {
            const stopping = performance.now();
            controller.abort();
            await reader.cancel().catch((error) => {
              if (!(error instanceof Error && error.name === "AbortError")) throw error;
            });
            if (performance.now() > deadline) fail("cleanup-deadline");
            // The reader is detached before a fresh request; no further events are consumed.
            return {
              terminal: "locally-aborted",
              firstDeltaMs: firstDelta,
              cleanupMs: Math.round(performance.now() - stopping),
            };
          }
        } else if (event.type === "response.completed") {
          decode(Completed)(parsed);
          completed = true;
          break;
        } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
          terminalFailure(event.type, parsed);
        } else if (event.type.includes("tool") || event.type.includes("function_call")) {
          fail("unexpected-output-item");
        }
      }
      if (Buffer.byteLength(pending) > 65536) fail("frame-byte-cap");
    }
    if (!text.trim()) fail("empty-output");
    return {
      terminal: "completed",
      firstDeltaMs: firstDelta,
      elapsedMs: Math.round(performance.now() - started),
      text,
    };
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function bounded(operation, milliseconds, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      failureObservation = { code: "deadline" };
      reject(new Error("qualification-stopped"));
    }, milliseconds);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function consumeResponse(response, controller, cancel, deadline, started) {
  const declared = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const mime = ["text/event-stream", "application/json", "text/plain", "text/html"].includes(declared)
    ? declared
    : "other-or-missing";
  failureObservation = { code: "qualification-or-setup-failed", status: response.status, mime };
  if (!response.ok) {
    const code = response.status === 401 ? "http-auth" : response.status === 429 ? "http-quota" : "http-provider";
    failureObservation = { code, status: response.status, mime };
    throw new Error("qualification-stopped");
  }
  if (!response.body) fail("content-type");
  return consume(response.body, controller, cancel, deadline, started);
}

const requestLimits = {
  "--execute-approved": 5,
  "--diagnose-approved": 1,
  "--remaining-approved": 4,
  "--after-summary-approved": 4,
};
async function experiment(models, token, signal, mode) {
  if (!models.includes(answerModel) || !models.includes(summaryModel)) fail("required-model-absent");
  const started = performance.now();
  const controllers = new Set();
  let requests = 0;
  let solRequests = 0;
  const invoke = async (label, model, prompt, cancel = false) => {
    requests++;
    if ((model === answerModel && ++solRequests > requestLimits[mode]) || performance.now() - started > 600000)
      fail("experiment-cap");
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const deadline = performance.now() + 30000;
    try {
      const result = await bounded(
        (async () => {
          const requestStarted = performance.now();
          const response = await fetch(endpoint, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${Redacted.value(token)}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(requestBody(model, prompt)),
          });
          return consumeResponse(response, controller, cancel, deadline, requestStarted);
        })(),
        30000,
        controller,
      );
      if (result.terminal !== (cancel ? "locally-aborted" : "completed")) fail("unexpected-terminal");
      const { text, ...observation } = result;
      console.log(JSON.stringify({ check: label, model, outcome: "OBSERVED", ...observation }));
      return text;
    } catch {
      for (const active of controllers) active.abort();
      const code =
        failureObservation.code === "qualification-or-setup-failed"
          ? "invalid-stream-or-transport"
          : failureObservation.code;
      failureObservation = { ...failureObservation, code, check: label };
      throw new Error("qualification-stopped");
    } finally {
      controller.abort();
      controllers.delete(controller);
      signal.removeEventListener("abort", abort);
    }
  };
  if (!["--remaining-approved", "--after-summary-approved"].includes(mode))
    await invoke("answer", answerModel, "Reply with one short greeting.");
  if (mode === "--diagnose-approved") {
    console.log(JSON.stringify({ outcome: "DIAGNOSTIC_COMPLETED", requests, qualification: "NOT_PROVEN" }));
    return;
  }
  if (mode !== "--after-summary-approved")
    await invoke("summary", summaryModel, "Summarize in one sentence: Alex likes quiet mornings and tea.");
  await invoke("interrupt", answerModel, "Write a detailed, lengthy description of a peaceful garden.", true);
  await invoke("fresh-answer", answerModel, "Reply with one short greeting.");
  await Promise.all([
    invoke("independent-answer-abort", answerModel, "Write a detailed, lengthy description of a forest.", true),
    invoke("independent-summary", summaryModel, "Summarize in one sentence: Robin practices French each morning."),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "balabol-qualification-"));
  try {
    const supplied = randomUUID();
    const withheld = randomUUID();
    await writeFile(join(directory, "withheld.txt"), withheld, { mode: 0o600 });
    const output = await invoke(
      "explicit-context-only",
      answerModel,
      `Supplied memory code: ${supplied}. Return exactly this code and then UNKNOWN for any unavailable file, shell or ambient memory code. No other text.`,
    );
    if (!output?.includes(supplied) || !output.includes("UNKNOWN") || output.includes(withheld))
      fail("synthetic-context-check");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      outcome: "PASS",
      answerPreviouslyObserved: ["--remaining-approved", "--after-summary-approved"].includes(mode),
      summaryPreviouslyObserved: mode === "--after-summary-approved",
      solRequests,
      requests,
      elapsedMs: Math.round(performance.now() - started),
      remoteComputeCessation: "NOT_PROVEN",
      applicationIntegration: "NOT_PROVEN",
    }),
  );
}

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
function fixture(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
async function selfTest() {
  assert.deepEqual(requestLimits, {
    "--execute-approved": 5,
    "--diagnose-approved": 1,
    "--remaining-approved": 4,
    "--after-summary-approved": 4,
  });
  const delta = frame({ type: "response.output_text.delta", delta: "hello" });
  const complete = frame({ type: "response.completed", response: { status: "completed" } });
  const read = (text, cancel = false) =>
    consume(fixture(text), new AbortController(), cancel, performance.now() + 1000);
  assert.equal((await read(delta + complete)).text, "hello");
  const wrongMime = new Response(delta + complete, { headers: { "content-type": "application/json" } });
  assert.equal(
    (await consumeResponse(wrongMime, new AbortController(), false, performance.now() + 1000, performance.now())).text,
    "hello",
  );
  const jsonQuota = new Response(
    JSON.stringify({ error: { code: "insufficient_quota", message: "SECRET_NOT_LOGGED" } }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    consumeResponse(jsonQuota, new AbortController(), false, performance.now() + 1000, performance.now()),
  );
  assert.equal(failureObservation.code, "provider-insufficient_quota");
  assert.ok(!JSON.stringify(failureObservation).includes("SECRET_NOT_LOGGED"));
  await assert.rejects(
    read(
      frame({
        type: "response.failed",
        response: { error: { code: "invalid_request_error", param: "store", message: "PRIVATE" } },
      }),
    ),
  );
  assert.equal(failureObservation.code, "response.failed");
  assert.equal(failureObservation.providerCode, "invalid_request_error");
  assert.equal(failureObservation.parameter, "store");
  assert.ok(!JSON.stringify(failureObservation).includes("PRIVATE"));
  await assert.rejects(read(frame({ type: "error", code: "SECRET", param: "PRIVATE" })));
  assert.equal(failureObservation.code, "error");
  assert.equal(failureObservation.providerCode, undefined);
  assert.equal(failureObservation.parameter, undefined);
  await assert.rejects(
    read(frame({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })),
  );
  assert.equal(failureObservation.reason, "max_output_tokens");
  const abortController = new AbortController();
  const abortBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(delta));
      abortController.signal.addEventListener(
        "abort",
        () => controller.error(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    },
  });
  assert.equal((await consume(abortBody, abortController, true, performance.now() + 1000)).terminal, "locally-aborted");
  assert.equal(abortBody.locked, false);
  const brokenBody = new ReadableStream({
    start(controller) {
      controller.error(new Error("transport failure"));
    },
  });
  await assert.rejects(consume(brokenBody, new AbortController(), true, performance.now() + 1000));
  assert.equal((await read(delta, true)).terminal, "locally-aborted");
  await assert.rejects(read(complete, true));
  const origin = performance.now() - 1234;
  assert.ok(
    (await consume(fixture(delta + complete), new AbortController(), false, performance.now() + 1000, origin))
      .firstDeltaMs >= 1234,
  );
  for (const text of [
    delta,
    delta + "data: [DONE]\n\n",
    "data: broken\n\n",
    frame({ type: "response.incomplete" }),
    complete,
    frame({ type: "response.output_text.delta", delta: 4 }),
    delta + frame({ type: "response.completed", response: { status: "incomplete" } }),
    frame({ type: "response.output_text.delta", delta: "x".repeat(4097) }),
    `data: ${"x".repeat(65536)}\n\n`,
  ]) {
    await assert.rejects(read(text));
  }
  assert.throws(() => fail("untrusted-provider-payload"));
  assert.deepEqual(failureObservation, { code: "qualification-or-setup-failed" });
  assert.ok(!JSON.stringify(failureObservation).includes("untrusted-provider-payload"));
  const request = requestBody(answerModel, "synthetic");
  assert.deepEqual(Object.keys(request).sort(), ["input", "instructions", "model", "store", "stream"]);
  assert.equal(request.store, false);
  assert.deepEqual(request.input, [{ role: "user", content: "synthetic" }]);
  await assert.rejects(consume(fixture(delta), new AbortController(), true, performance.now() - 1));
  const controller = new AbortController();
  await assert.rejects(bounded(new Promise(() => {}), 1, controller));
  assert.equal(controller.signal.aborted, true);
  console.log(
    "PASS fixture qualification: completion, invalid/incomplete/EOF, caps, cancellation, deadlines and request allowlist; zero network requests",
  );
}

try {
  if (process.argv[2] === "--self-test" && process.argv.length === 3) {
    await selfTest();
  } else if (Object.hasOwn(requestLimits, process.argv[2]) && process.argv.length === 3) {
    const { Subscription, subscriptionLayer } = await import("../dist/subscription/index.js");
    const program = Effect.gen(function* () {
      const subscription = yield* Subscription;
      const models = yield* subscription.models().pipe(Effect.timeout(30000));
      const token = yield* subscription.accessToken();
      yield* Effect.tryPromise({
        try: (signal) => experiment(models, token, signal, process.argv[2]),
        catch: () => new Error("qualification-failed"),
      });
    }).pipe(
      Effect.provide(
        subscriptionLayer(
          process.env.BALABOL_SUBSCRIPTION_DIRECTORY ?? join(homedir(), ".local", "share", "balabol", "subscription"),
        ),
      ),
      Effect.timeout(600000),
    );
    await Effect.runPromise(program);
  } else {
    fail(
      "Use --self-test, or an approved --execute-approved/--diagnose-approved/--remaining-approved/--after-summary-approved after subscription-only cost confirmation.",
    );
  }
} catch {
  console.error(JSON.stringify({ outcome: "FAIL", ...failureObservation, retries: 0 }));
  process.exitCode = 1;
}
