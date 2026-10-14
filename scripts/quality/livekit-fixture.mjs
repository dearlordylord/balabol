import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = "livekit/livekit-server@sha256:d0c04791bf63ca8dcea123571827d56ba9504bd57c8d5de60ee03b5408cc3154";
const tcpPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null)
        return server.close(() => reject(new Error("Missing TCP address")));
      server.close(() => resolve(address.port));
    });
  });
const udpPort = () =>
  new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
const docker = (args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`LiveKit fixture requires working Docker: ${result.error?.message ?? result.stderr}`);
};

/** Real, isolated transport for gates; synthetic RTC input does not qualify a microphone. */
export const withLiveKitFixture = async (action) => {
  if (process.env.BALABOL_LIVEKIT_TEST_ENV) return action(process.env.BALABOL_LIVEKIT_TEST_ENV);
  const directory = mkdtempSync(join(tmpdir(), "balabol-quality-livekit-"));
  const name = `balabol-quality-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const [port, tcp, udp] = await Promise.all([tcpPort(), tcpPort(), udpPort()]);
    const key = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const config = join(directory, "livekit.yaml");
    writeFileSync(
      config,
      JSON.stringify({
        port,
        bind_addresses: ["0.0.0.0"],
        rtc: { node_ip: "127.0.0.1", use_external_ip: false, tcp_port: tcp, udp_port: udp },
        keys: { [key]: secret },
        logging: { level: "error" },
      }),
      { mode: 0o600 },
    );
    const environment = join(directory, "backend.env");
    writeFileSync(
      environment,
      `BALABOL_LIVEKIT_URL=ws://127.0.0.1:${port}\nBALABOL_LIVEKIT_MEDIA_URL=ws://127.0.0.1:${port}\nBALABOL_LIVEKIT_API_KEY=${key}\nBALABOL_LIVEKIT_API_SECRET=${secret}\n`,
      { mode: 0o600 },
    );
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      `127.0.0.1:${port}:${port}/tcp`,
      "--publish",
      `127.0.0.1:${tcp}:${tcp}/tcp`,
      "--publish",
      `127.0.0.1:${udp}:${udp}/udp`,
      "--mount",
      `type=bind,source=${config},target=/etc/livekit.yaml,readonly`,
      image,
      "--config",
      "/etc/livekit.yaml",
    ]);
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {
        /* Startup is bounded below. */
      }
      if (Date.now() >= deadline) throw new Error("LiveKit fixture did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await action(environment);
  } finally {
    // Also clean up if Docker created the container before its CLI failed or timed out.
    spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 15000 });
    rmSync(directory, { recursive: true, force: true });
  }
};
