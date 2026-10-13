import { existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

export const sourceFiles = (root) => {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Symbolic source root: ${root}`);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic source dependency: ${path}`);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
};
