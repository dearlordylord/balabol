import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = fileURLToPath(new URL("../../", import.meta.url));
export const command = (root, executable, args, silent = false) => {
  const path = ["gitleaks", "pnpm"].includes(executable)
    ? executable
    : resolve(repository, "node_modules/.bin", executable);
  const result = spawnSync(path, args, { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (!silent && result.stdout) process.stdout.write(result.stdout);
  if (!silent && result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0)
    throw new Error(`${executable} failed: ${result.error?.message ?? result.status}`);
  return result.stdout;
};
