import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const commands = ["qualify.mjs", "domain-qualify.mjs"];
if (existsSync(resolve(root, "src/conversation/admission-core/core.bend"))) commands.push("check-admission.mjs");
for (const command of commands) {
  const result = spawnSync(process.execPath, [resolve(directory, command)], {
    cwd: root,
    stdio: "inherit",
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bend gate failed: ${command} (${result.status ?? result.signal})`);
}
