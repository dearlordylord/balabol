import assert from "node:assert/strict";

// This is an ABI reader, not a Bend parser. The compiler checks bodies; this
// reader refuses every interface shape outside the concrete first-order subset.
export function domainDeclarations(source) {
  const types = new Map();
  const functions = [];
  let activeType;
  for (const line of source.split("\n")) {
    if (line.trim() === "" || /^#/.test(line)) continue;
    if (/^import Base$/.test(line)) continue;
    const type = /^type ([A-Z][A-Za-z]*) is Data:$/.exec(line);
    if (type) {
      assert.ok(!types.has(type[1]), "Duplicate Bend type");
      activeType = [];
      types.set(type[1], activeType);
      continue;
    }
    if (activeType && line.startsWith("  ")) {
      const constructor = /^  ([A-Z][A-Za-z]*)\{(.*)\}$/.exec(line);
      assert.ok(constructor, `Unsupported Bend constructor: ${line}`);
      const fields =
        constructor[2] === ""
          ? []
          : constructor[2].split(", ").map((field) => {
              const match = /^([a-z][A-Za-z]*): ([A-Z][A-Za-z]*)$/.exec(field);
              assert.ok(match, `Unsupported Bend field: ${field}`);
              return { name: match[1], type: match[2] };
            });
      activeType.push({ name: constructor[1], fields });
      continue;
    }
    activeType = undefined;
    const definition = /^def ([a-z][a-z_]*)(\([^\n]*\)) -> ([A-Z][A-Za-z]*):$/.exec(line);
    if (definition) {
      const raw = definition[2].slice(1, -1);
      const parameters =
        raw === ""
          ? []
          : raw.split(", ").map((parameter) => {
              const match = /^\+?([a-z][A-Za-z]*): ([A-Z][A-Za-z]*)$/.exec(parameter);
              assert.ok(match, `Unsupported Bend parameter: ${parameter}`);
              return { name: match[1], type: match[2] };
            });
      functions.push({ name: definition[1], parameters, result: definition[3] });
      continue;
    }
    assert.ok(/^  /.test(line) && functions.length > 0, `Unsupported Bend top-level declaration: ${line}`);
    assert.doesNotMatch(line, /\b(?:unsafe|foreign)\b|^ +import\b/, "Unsafe or foreign code is not qualified");
  }
  const encode = (type) => {
    if (type === "Nat") return "bigint";
    if (type === "Bool") return "boolean";
    assert.ok(types.has(type), `Unqualified Bend ABI type: ${type}`);
    return type;
  };
  const declarations = [...types].map(([name, constructors]) => {
    assert.ok(constructors.length > 0, "Empty Bend datatype");
    const variants = constructors.map(
      (constructor) =>
        `{ readonly $: ${JSON.stringify(constructor.name)}${constructor.fields.map((field) => `; readonly ${field.name}: ${encode(field.type)}`).join("")} }`,
    );
    return `export type ${name} = ${variants.join(" | ")};`;
  });
  assert.ok(functions.length > 0, "No concrete Bend exports found");
  const members = functions.map(
    (definition) =>
      `  readonly ${definition.name}: (${definition.parameters.map((parameter) => `${parameter.name}: ${encode(parameter.type)}`).join(", ")}) => ${encode(definition.result)};`,
  );
  return `${declarations.join("\n")}\ndeclare const core: {\n${members.join("\n")}\n};\nexport default core;\n`;
}
