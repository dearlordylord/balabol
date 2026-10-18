import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultModelPath } from "./prepare-vad.mjs";

const image = "livekit/livekit-server@sha256:d0c04791bf63ca8dcea123571827d56ba9504bd57c8d5de60ee03b5408cc3154";
const ports = { control: 8444, media: 8443, backend: 8787, rtcTcp: 7881, rtcUdp: 7882 };
const root = fileURLToPath(new URL("../", import.meta.url));

export const providerEnvironment = (args, environment) => {
  if (args.some((arg) => !["--check", "--real"].includes(arg))) throw new Error("Unknown option; use --help.");
  if (!args.includes("--real")) return { ...environment };
  const selected = {
    ...environment,
    BALABOL_ANSWER_PROVIDER: environment.BALABOL_ANSWER_PROVIDER ?? "subscription",
    BALABOL_SUMMARY_PROVIDER: environment.BALABOL_SUMMARY_PROVIDER ?? "subscription",
    BALABOL_RECOGNITION_PROVIDER: environment.BALABOL_RECOGNITION_PROVIDER ?? "qwen3-asr",
    BALABOL_SYNTHESIS_PROVIDER: environment.BALABOL_SYNTHESIS_PROVIDER ?? "apple",
    BALABOL_ACTIVITY_PROVIDER: environment.BALABOL_ACTIVITY_PROVIDER ?? "silero",
    BALABOL_VOICE_DIAGNOSTICS: environment.BALABOL_VOICE_DIAGNOSTICS ?? "1",
  };
  if (selected.BALABOL_ANSWER_PROVIDER === "subscription")
    selected.BALABOL_ANSWER_MODEL = environment.BALABOL_ANSWER_MODEL ?? "gpt-6.1-sol";
  if (selected.BALABOL_SUMMARY_PROVIDER === "subscription")
    selected.BALABOL_SUMMARY_MODEL = environment.BALABOL_SUMMARY_MODEL ?? "gpt-6-luna";
  return selected;
};

export const providerDescription = (environment) =>
  `answers=${environment.BALABOL_ANSWER_PROVIDER ?? "fake"}, memory summaries=${environment.BALABOL_SUMMARY_PROVIDER ?? "fake"}, recognition=${environment.BALABOL_RECOGNITION_PROVIDER ?? "fake"}, synthesis=${environment.BALABOL_SYNTHESIS_PROVIDER ?? "fake"}, speech activity=${environment.BALABOL_ACTIVITY_PROVIDER ?? (environment.BALABOL_RECOGNITION_PROVIDER === "qwen3-asr" ? "silero" : "fake")}`;

// Existence/permissions only: provider acquisition owns engine and weight validation.
export const localRequirements = (environment, includeHelper = true) => {
  const requirements = [];
  if (environment.BALABOL_RECOGNITION_PROVIDER === "qwen3-asr") {
    requirements.push(
      {
        label: "Qwen Python runtime",
        path:
          environment.BALABOL_QWEN_PYTHON_PATH ??
          join(homedir(), ".local/share/balabol/tools/qwen-asr/.venv/bin/python"),
        mode: constants.X_OK,
      },
      {
        label: "Qwen helper",
        path: environment.BALABOL_QWEN_HELPER_PATH ?? join(root, "scripts/qwen-asr.py"),
        mode: constants.R_OK,
      },
      {
        label: "Qwen model configuration",
        path: join(
          environment.BALABOL_QWEN_MODEL ?? join(homedir(), ".local/share/balabol/models/qwen3-asr-1.7b"),
          "config.json",
        ),
        mode: constants.R_OK,
      },
    );
  }
  if (environment.BALABOL_SYNTHESIS_PROVIDER === "apple") {
    requirements.push({
      label: "ffmpeg executable",
      path: environment.BALABOL_FFMPEG_EXECUTABLE ?? "/opt/homebrew/bin/ffmpeg",
      mode: constants.X_OK,
    });
    if (includeHelper)
      requirements.push({
        label: "Apple speech helper (run pnpm build:speech)",
        path:
          environment.BALABOL_APPLE_SPEECH_EXECUTABLE ??
          join(homedir(), ".local/share/balabol/tools/apple-speech/apple-speech"),
        mode: constants.X_OK,
      });
  }
  if (
    (environment.BALABOL_ACTIVITY_PROVIDER ??
      (environment.BALABOL_RECOGNITION_PROVIDER === "qwen3-asr" ? "silero" : "fake")) === "silero"
  )
    requirements.push({
      label: "Silero VAD weights (run pnpm prepare:vad)",
      path: environment.BALABOL_VAD_MODEL ?? defaultModelPath,
      mode: constants.R_OK,
    });
  return requirements;
};
export const checkLocalResources = (environment, includeHelper = true) => {
  for (const requirement of localRequirements(environment, includeHelper)) {
    try {
      if (!statSync(requirement.path).isFile()) throw new Error("Not a file");
      accessSync(requirement.path, requirement.mode);
    } catch {
      throw new Error(`Missing or inaccessible ${requirement.label}: ${requirement.path}`);
    }
  }
};

export const tailnetIdentity = (status) => {
  const self = status.Self;
  const owner = status.User?.[String(self?.UserID)]?.LoginName;
  const hostname = self?.DNSName?.replace(/\.$/u, "");
  const ip = self?.TailscaleIPs?.find((value) => /^100\.\d+\.\d+\.\d+$/u.test(value));
  if (status.BackendState !== "Running" || !owner || !hostname || !ip)
    throw new Error("Sign in to Tailscale as the owner on this Mac before running dev:voice.");
  if (!status.CertDomains?.includes(hostname))
    throw new Error(
      "Enable HTTPS certificates in your Tailscale admin DNS settings, then rerun dev:voice. This launcher does not enable public Funnel.",
    );
  return { owner, hostname, ip };
};

export const ownsServePort = (status, hostname, port, target) => {
  const handlers = status.Web?.[`${hostname}:${port}`]?.Handlers;
  return handlers !== undefined && Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === target;
};

const command = (name, args, timeout = 15000) => {
  const result = spawnSync(name, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(
      `${name} failed. Check that it is installed, running and signed in; no existing process was stopped.`,
    );
  return result.stdout;
};
const json = (name, args) => JSON.parse(command(name, args));
const pause = (millis) => new Promise((resolvePause) => setTimeout(resolvePause, millis));
const tcpAvailable = (port, host = "127.0.0.1") =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(new Error(`TCP ${host}:${port} is occupied. Stop its owner yourself before running dev:voice.`)),
    );
    server.listen(port, host, () => {
      const address = server.address();
      const selected = typeof address === "object" && address !== null ? address.port : port;
      server.close(() => resolvePort(selected));
    });
  });
const udpAvailable = (port) =>
  new Promise((resolvePort, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      reject(new Error(`UDP ${port} is occupied. Stop its owner yourself before running dev:voice.`));
    });
    socket.bind(port, "0.0.0.0", () => {
      socket.close(() => resolvePort(port));
    });
  });
export class StartupAborted extends Error {}
export const ready = async (url, alive) => {
  const deadline = Date.now() + 15000;
  while (alive()) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Acquisition has a bounded readiness deadline. */
    }
    if (Date.now() >= deadline) break;
    await pause(100);
  }
  if (!alive()) throw new StartupAborted();
  throw new Error(
    "Voice startup did not become ready. Check Docker and the conversation database writer; existing services and data are preserved.",
  );
};

/** Optional data readiness is checked separately from voice prerequisites. */
export const dictionaryReadiness = (environment) => {
  const result = spawnSync(process.execPath, [join(root, "scripts/prepare-dictionary.mjs"), "--check"], {
    env: environment,
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status === 0) return "Dictionary: ready (English, French, Russian).";
  return `Dictionary: UNAVAILABLE. Run pnpm prepare:dictionary, then restart the backend. Ordinary chat remains available.\n${result.stderr?.trim() || result.error?.message || "Catalog verification failed"}`;
};

export const main = async (args) => {
  if (args.includes("--help")) {
    console.log(
      "pnpm dev:voice [--real] [--check]\nDefaults to fake providers. --real selects subscription Sol/Luna, local Qwen3-ASR and Apple speech; explicit BALABOL_* overrides win. Private Tailscale media/control routes only. --check checks prerequisites without compiling, starting services or inference.",
    );
    return;
  }
  const environment = providerEnvironment(args, process.env);
  const check = args.includes("--check");
  console.log(dictionaryReadiness(environment));
  checkLocalResources(environment, check);
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Use Node 24 and the repository's pinned pnpm.");
  command("docker", ["info", "--format", "{{.ServerVersion}}"]);
  const tailnet = tailnetIdentity(json("tailscale", ["status", "--json"]));
  const existing = json("tailscale", ["serve", "status", "--json"]);
  for (const port of [ports.control, ports.media]) {
    if (existing.TCP?.[String(port)] || existing.Web?.[`${tailnet.hostname}:${port}`])
      throw new Error(
        `Tailscale Serve port ${port} already belongs to another service. This launcher will not replace it; keep existing port 9999 untouched.`,
      );
  }
  await Promise.all([tcpAvailable(ports.backend), tcpAvailable(ports.rtcTcp, "0.0.0.0"), udpAvailable(ports.rtcUdp)]);
  if (check) {
    console.log(
      `Voice prerequisites are ready (${providerDescription(environment)}). Existing Tailscale Serve configuration and processes were not changed. No compilation or inference ran.`,
    );
    return;
  }
  if (environment.BALABOL_SYNTHESIS_PROVIDER === "apple") command("pnpm", ["build:speech"], 60000);
  command("pnpm", ["build"], 60000);
  const signalPort = await tcpAvailable(0);
  const directory = mkdtempSync(join(tmpdir(), "balabol-voice-"));
  const name = `balabol-voice-${process.pid}-${randomBytes(4).toString("hex")}`;
  const key = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const config = join(directory, "livekit.yaml");
  const targets = new Map([
    [ports.media, `http://127.0.0.1:${signalPort}`],
    [ports.control, `http://127.0.0.1:${ports.backend}/tailnet`],
  ]);
  const createdRoutes = new Set();
  let backend;
  let stopping = false;
  let complete;
  const lifetime = new Promise((resolveLifetime) => {
    complete = resolveLifetime;
  });
  const requestStop = (exitCode) => {
    if (!stopping && exitCode !== undefined) process.exitCode = exitCode;
    stopping = true;
    complete();
  };
  const ensureRunning = () => {
    if (stopping) throw new StartupAborted();
  };
  let cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      if (backend !== undefined && backend.exitCode === null) {
        await new Promise((resolveExit) => {
          const deadline = setTimeout(() => {
            backend.kill("SIGKILL");
            resolveExit();
          }, 5000);
          backend.once("exit", () => {
            clearTimeout(deadline);
            resolveExit();
          });
          backend.kill("SIGTERM");
        });
      }
      try {
        const current = json("tailscale", ["serve", "status", "--json"]);
        for (const [port, target] of targets) {
          if (createdRoutes.has(port) && ownsServePort(current, tailnet.hostname, port, target))
            command("tailscale", ["serve", `--https=${port}`, "off"]);
        }
      } catch {
        console.error(
          "Could not remove owned Serve routes. Check ports 8443/8444; existing unrelated routes were preserved.",
        );
      }
      spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 15000 });
      rmSync(directory, { recursive: true, force: true });
    })());
  const interrupt = () => requestStop(130);
  const terminate = () => requestStop(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    ensureRunning();
    writeFileSync(
      config,
      JSON.stringify({
        port: signalPort,
        bind_addresses: ["0.0.0.0"],
        rtc: { node_ip: tailnet.ip, use_external_ip: false, tcp_port: ports.rtcTcp, udp_port: ports.rtcUdp },
        keys: { [key]: secret },
        logging: { level: "error" },
      }),
      { mode: 0o600 },
    );
    ensureRunning();
    command(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        name,
        "--publish",
        `127.0.0.1:${signalPort}:${signalPort}/tcp`,
        "--publish",
        `${ports.rtcTcp}:${ports.rtcTcp}/tcp`,
        "--publish",
        `${ports.rtcUdp}:${ports.rtcUdp}/udp`,
        "--mount",
        `type=bind,source=${config},target=/etc/livekit.yaml,readonly`,
        image,
        "--config",
        "/etc/livekit.yaml",
      ],
      60000,
    );
    await ready(`http://127.0.0.1:${signalPort}`, () => !stopping);
    ensureRunning();
    backend = spawn(process.execPath, ["dist/bootstrap/main.js"], {
      cwd: root,
      stdio: "ignore",
      env: {
        ...environment,
        BALABOL_HOST: "127.0.0.1",
        BALABOL_PORT: String(ports.backend),
        BALABOL_DATABASE: environment.BALABOL_DATABASE ?? ".data/conversation.sqlite",
        BALABOL_TAILNET_OWNER: tailnet.owner,
        BALABOL_LIVEKIT_URL: `ws://127.0.0.1:${signalPort}`,
        BALABOL_LIVEKIT_MEDIA_URL: `wss://${tailnet.hostname}:${ports.media}`,
        BALABOL_LIVEKIT_API_KEY: key,
        BALABOL_LIVEKIT_API_SECRET: secret,
      },
    });
    backend.once("error", () => {
      if (!stopping) console.error("Could not start the voice backend.");
      requestStop(1);
    });
    backend.once("exit", () => {
      if (!stopping) {
        process.exitCode = 1;
        console.error("Voice backend stopped. Check the database writer and configuration.");
      }
      requestStop(1);
    });
    await ready(`http://127.0.0.1:${ports.backend}`, () => !stopping);
    for (const [port, target] of targets) {
      ensureRunning();
      const current = json("tailscale", ["serve", "status", "--json"]);
      if (current.TCP?.[String(port)] || current.Web?.[`${tailnet.hostname}:${port}`])
        throw new Error(`Serve port ${port} was acquired by another service during startup; it was preserved.`);
      ensureRunning();
      createdRoutes.add(port);
      command("tailscale", ["serve", "--bg", "--yes", `--https=${port}`, target]);
      if (!ownsServePort(json("tailscale", ["serve", "status", "--json"]), tailnet.hostname, port, target))
        throw new Error("Tailscale Serve did not retain the required private proxy target.");
    }
    ensureRunning();
    console.log(
      `Voice is ready (${providerDescription(environment)}).\nSimulator: http://127.0.0.1:${ports.backend}\niPhone control: https://${tailnet.hostname}:${ports.control}\nMedia: wss://${tailnet.hostname}:${ports.media}\nKeep this Terminal open. Ctrl-C stops only this launch; the saved conversation remains.`,
    );
    await lifetime;
  } catch (error) {
    if (!(error instanceof StartupAborted)) throw error;
  } finally {
    // Startup reaches this boundary before cleanup: no awaited continuation can acquire after it.
    stopping = true;
    await cleanup();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    if (process.exitCode === 130 || process.exitCode === 143) return;
    console.error(error.message);
    process.exitCode = 1;
  });
}
