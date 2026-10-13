import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript-compiler-api";
import { Schema } from "effect";

const Owner = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  root: Schema.NonEmptyString,
  entry: Schema.NonEmptyString,
  dependencies: Schema.Array(Schema.String),
});
const Manifest = Schema.Struct({ owners: Schema.Array(Owner) });
const Packages = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export const checkArchitecture = (directory, files) => {
  const root = realpathSync(directory);
  const { owners } = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    readFileSync(resolve(root, "quality-owners.json"), "utf8"),
  );
  const ownerFor = (path) => owners.find((owner) => path.startsWith(`${resolve(root, owner.root)}/`));
  const configFile = resolve(root, "tsconfig.json");
  const config = existsSync(configFile) ? ts.readConfigFile(configFile, ts.sys.readFile) : { config: {} };
  if (config.error)
    throw new Error("Invalid tsconfig: " + ts.flattenDiagnosticMessageText(config.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const invalidConfig = parsed.errors.filter((error) => error.code !== 18003);
  if (invalidConfig.length)
    throw new Error("Invalid tsconfig: " + ts.flattenDiagnosticMessageText(invalidConfig[0].messageText, " "));
  if (!existsSync(configFile)) parsed.options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
  const manifestPath = resolve(root, "package.json");
  const manifest = existsSync(manifestPath)
    ? Schema.decodeUnknownSync(Schema.fromJsonString(Packages))(readFileSync(manifestPath, "utf8"))
    : {};
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const graph = new Map();
  const queue = [...files];
  for (const file of queue) {
    const from = realpathSync(file);
    if (graph.has(from)) continue;
    const owner = ownerFor(from);
    if (!owner) throw new Error(`Undeclared owner: ${relative(root, from)}`);
    const edges = [];
    const add = (specifier) => {
      const resolved = ts.resolveModuleName(specifier, from, parsed.options, ts.sys).resolvedModule;
      if (resolved?.isExternalLibraryImport) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!specifier.startsWith("node:") && !(packageName in dependencies))
          throw new Error(`Undeclared package: ${specifier}`);
        return;
      }
      if (specifier.startsWith("node:")) {
        if (!builtinModules.includes(specifier) && !builtinModules.includes(specifier.slice(5)))
          throw new Error(`Unknown Node module: ${specifier}`);
        return;
      }
      if (!resolved) throw new Error(`Unresolved dependency: ${specifier} from ${from}`);
      const target = realpathSync(resolved.resolvedFileName);
      const targetOwner = ownerFor(target);
      if (!targetOwner) throw new Error(`Undeclared dependency owner: ${target}`);
      if (targetOwner.name !== owner.name) {
        if (!owner.dependencies.includes(targetOwner.name))
          throw new Error(`Forbidden owner dependency: ${owner.name} -> ${targetOwner.name}`);
        if (target !== realpathSync(resolve(root, targetOwner.root, targetOwner.entry)))
          throw new Error(`Private entrypoint: ${target}`);
      }
      edges.push(target);
      queue.push(target);
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === "createRequire")
        throw new Error(`Module-loader factories are not statically reviewable: ${from}`);
      if (
        ts.isIdentifier(node) &&
        node.text === "require" &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      )
        throw new Error(`Aliased module loaders are not statically reviewable: ${from}`);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        add(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument))
          throw new Error(`Computed dependency is not statically reviewable: ${from}`);
        add(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Invalid source syntax: ${from}`);
    visit(source);
    graph.set(from, edges);
  }
  const names = new Set();
  for (const owner of owners) {
    if (names.has(owner.name)) throw new Error(`Duplicate owner: ${owner.name}`);
    names.add(owner.name);
    const base = resolve(root, owner.root);
    const entry = resolve(base, owner.entry);
    if (
      isAbsolute(owner.root) ||
      relative(root, base).startsWith("..") ||
      !relative(base, entry) ||
      relative(base, entry).startsWith("..")
    )
      throw new Error(`Owner path escapes repository: ${owner.name}`);
    if (
      owners.some(
        (other) =>
          other !== owner && (resolve(root, other.root) === base || resolve(root, other.root).startsWith(`${base}/`)),
      )
    )
      throw new Error(`Overlapping owner roots: ${owner.name}`);
  }
  const visited = new Set();
  const visiting = new Set();
  const walk = (file) => {
    if (visiting.has(file)) throw new Error(`Dependency cycle: ${relative(root, file)}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) walk(dependency);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of graph.keys()) walk(file);
  for (const owner of owners) {
    if (existsSync(resolve(root, owner.root)) && !existsSync(resolve(root, owner.root, owner.entry)))
      throw new Error(`Missing public entrypoint: ${owner.name}`);
    for (const dependency of owner.dependencies)
      if (!owners.some((candidate) => candidate.name === dependency))
        throw new Error(`Unknown declared dependency: ${dependency}`);
  }
  const ownerGraph = new Map(owners.map((owner) => [owner.name, owner.dependencies]));
  visited.clear();
  visiting.clear();
  const walkOwner = (name) => {
    if (visiting.has(name)) throw new Error(`Declared owner cycle: ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of ownerGraph.get(name)) walkOwner(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of names) walkOwner(name);
};
