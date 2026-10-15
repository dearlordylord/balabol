import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const directory = join(homedir(), ".local/share/balabol/tools/apple-speech");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const temporary = join(directory, `apple-speech-${process.pid}`);
const result = spawnSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    "-swift-version",
    "6",
    "-strict-concurrency=complete",
    "-warnings-as-errors",
    "-O",
    "src/speech-synthesis/apple-speech.swift",
    "src/speech-synthesis/apple-render-plan.swift",
    "-o",
    temporary,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  rmSync(temporary, { force: true });
  process.exit(result.status ?? 1);
}
renameSync(temporary, join(directory, "apple-speech"));
console.log(`Built ${join(directory, "apple-speech")}`);
