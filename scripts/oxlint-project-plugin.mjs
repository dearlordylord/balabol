const report = (context, node, message) => {
  context.report({ node, message });
};

const reportRestricted = report;

const memberName = (node) => {
  if (node.computed && node.property.type === "Literal") return node.property.value;
  if (node.property.type === "Identifier") return node.property.name;
  return undefined;
};

const isIdentifier = (node, name) => node?.type === "Identifier" && node.name === name;

const naturalKeyCollator = new Intl.Collator("en", { numeric: true });

const patternKey = (node) => {
  if (node.type === "RestElement") return { name: node.argument.name, order: 99 };
  if (node.type !== "Property" || node.computed) return undefined;
  if (node.key.type === "Identifier") return { name: node.key.name, order: 1 };
  if (node.key.type === "Literal") return { name: String(node.key.value), order: 1 };
  return undefined;
};

const containsIdentifier = (node, names) => {
  if (node === null || typeof node !== "object") return false;
  if (node.type === "Identifier" && names.has(node.name)) return true;
  return Object.entries(node).some(([key, value]) => {
    if (key === "parent" || key === "range" || key === "loc") return false;
    if (Array.isArray(value)) return value.some((entry) => containsIdentifier(entry, names));
    return containsIdentifier(value, names);
  });
};

const sortablePattern = (node) => {
  const keys = node.properties.map(patternKey);
  if (keys.some((key) => key === undefined)) return undefined;

  const boundNames = new Set(keys.map((key) => key.name));
  const orderSensitive = node.properties.some(
    (property) =>
      property.type === "Property" &&
      property.value.type === "AssignmentPattern" &&
      containsIdentifier(property.value.right, boundNames),
  );
  return orderSensitive ? undefined : keys;
};

const sortDestructureKeys = {
  meta: {
    fixable: "code",
  },
  create: (context) => ({
    ObjectPattern: (node) => {
      const keys = sortablePattern(node);
      if (keys === undefined) return;

      const indexed = node.properties.map((property, index) => ({ property, key: keys[index] }));
      const sorted = indexed.toSorted(
        (left, right) => left.key.order - right.key.order || naturalKeyCollator.compare(left.key.name, right.key.name),
      );
      const mismatch = indexed.findIndex((entry, index) => entry.property !== sorted[index].property);
      if (mismatch === -1) return;

      context.report({
        node: indexed[mismatch].property,
        message: `Expected object destructuring keys to be sorted; ${sorted[mismatch].key.name} belongs before ${indexed[mismatch].key.name}.`,
        fix: (fixer) => {
          const source = context.sourceCode.text;
          const separators = node.properties
            .slice(0, -1)
            .map((property, index) => source.slice(property.range[1], node.properties[index + 1].range[0]));
          const text = sorted
            .map(({ property }, index) => context.sourceCode.getText(property) + (separators[index] ?? ""))
            .join("");
          return fixer.replaceTextRange([node.properties[0].range[0], node.properties.at(-1).range[1]], text);
        },
      });
    },
  }),
};

const noClockRead = {
  create: (context) => ({
    NewExpression: (node) => {
      if (isIdentifier(node.callee, "Date") && node.arguments.length === 0) {
        reportRestricted(
          context,
          node,
          "Zero-argument new Date() is banned. Use Effect DateTime.now or inject a clock.",
        );
      }
    },
    CallExpression: (node) => {
      if (isIdentifier(node.callee, "Date") && node.arguments.length === 0)
        report(context, node, "Date() is banned; inject a clock.");
      if (
        node.callee.type === "MemberExpression" &&
        (isIdentifier(node.callee.object, "Date") || isIdentifier(node.callee.object, "performance")) &&
        memberName(node.callee) === "now"
      ) {
        reportRestricted(context, node, "Date.now() is banned. Use Effect Clock.currentTimeMillis or DateTime.now.");
      }
    },
  }),
};

const noDoubleTypeAssertion = {
  create: (context) => ({
    TSAsExpression: (node) => {
      if (node.expression.type === "TSAsExpression") {
        reportRestricted(
          context,
          node,
          "Double type assertions require an explicit Oxlint suppression with justification.",
        );
      }
    },
  }),
};

const forbiddenViMembers = new Set([
  "clearAllMocks",
  "doMock",
  "fn",
  "hoisted",
  "mock",
  "mocked",
  "spyOn",
  "stubGlobal",
  "unmock",
  "unstubAllGlobals",
  "stubEnv",
  "setSystemTime",
  "useFakeTimers",
  "useRealTimers",
  "resetModules",
  "resetAllMocks",
  "restoreAllMocks",
]);

const noTestMocks = {
  create: (context) => {
    const imported = new Set();
    const testApis = new Set(["vi", "jest"]);
    const bannedCalls = new Set();
    const rootedInImport = (node) =>
      node &&
      (node.type === "Identifier"
        ? imported.has(node.name) ||
          ["globalThis", "global", "Math", "Date", "performance", "process"].includes(node.name)
        : node.type === "MemberExpression" && rootedInImport(node.object));
    return {
      ImportDeclaration: (node) => {
        for (const specifier of node.specifiers) {
          imported.add(specifier.local.name);
          if (["vitest", "@effect/vitest", "@jest/globals"].includes(node.source.value)) {
            testApis.add(specifier.local.name);
            if (specifier.type === "ImportSpecifier" && forbiddenViMembers.has(specifier.imported.name))
              bannedCalls.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator: (node) => {
        if (node.id.type === "Identifier" && node.init?.type === "Identifier" && testApis.has(node.init.name))
          testApis.add(node.id.name);
        if (node.id.type !== "ObjectPattern" || node.init?.type !== "Identifier" || !testApis.has(node.init.name))
          return;
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            forbiddenViMembers.has(property.key.name) &&
            property.value.type === "Identifier"
          )
            bannedCalls.add(property.value.name);
        }
      },
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && bannedCalls.has(node.callee.name))
          report(context, node, "Test mocks are banned; use Layers or explicit ports.");
        if (node.callee.type !== "MemberExpression") return;
        const name = memberName(node.callee);
        const object = node.callee.object;
        const testApi =
          object.type === "Identifier"
            ? testApis.has(object.name)
            : object.type === "MemberExpression" && rootedInImport(object);
        if (testApi && forbiddenViMembers.has(name))
          report(context, node, "Test mocks are banned; use Layers or explicit ports.");
        if (["defineProperty", "defineProperties", "assign", "set"].includes(name) && rootedInImport(node.arguments[0]))
          report(context, node, "Module monkey-patching is banned; use Layers or explicit ports.");
      },
      AssignmentExpression: (node) => {
        if (node.left.type === "MemberExpression" && rootedInImport(node.left))
          report(context, node, "Module monkey-patching is banned; use Layers or explicit ports.");
      },
    };
  },
};

const noTypeAssertion = {
  create: (context) => ({
    TSAsExpression: (node) => {
      const annotation = node.typeAnnotation;
      const isConst = annotation.type === "TSTypeReference" && isIdentifier(annotation.typeName, "const");
      if (!isConst) {
        reportRestricted(context, node, "Type assertions are banned. Parse, use satisfies, or restructure the code.");
      }
    },
  }),
};

const propertyTestPlacement = {
  create: (context) => {
    if (context.filename.endsWith(".property.test.ts")) return {};
    return {
      ImportDeclaration: (node) => {
        if (node.source.value === "fast-check" || node.source.value.startsWith("fast-check/")) {
          report(context, node, "Property-based tests must live in *.property.test.ts files.");
        }
      },
      CallExpression: (node) => {
        if (
          node.callee.type === "MemberExpression" &&
          ["property", "asyncProperty", "prop"].includes(memberName(node.callee))
        ) {
          report(context, node, "Move fc.property tests to a *.property.test.ts file.");
        }
      },
    };
  },
};

const requireCanonicalEffectSchemaImport = {
  create: (context) => ({
    ImportDeclaration: (node) => {
      if (node.source.value !== "effect") return;
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          reportRestricted(context, specifier, "Do not namespace-import Effect; import Schema by its canonical name.");
        }
        if (
          specifier.type === "ImportSpecifier" &&
          isIdentifier(specifier.imported, "Schema") &&
          !isIdentifier(specifier.local, "Schema")
        ) {
          reportRestricted(context, specifier, "Do not alias Schema imports from Effect.");
        }
      }
    },
  }),
};

export default {
  meta: {
    name: "balabol",
  },
  rules: {
    "no-clock-read": noClockRead,
    "no-double-type-assertion": noDoubleTypeAssertion,
    "no-test-mocks": noTestMocks,
    "no-type-assertion": noTypeAssertion,
    "property-test-placement": propertyTestPlacement,
    "require-canonical-effect-schema-import": requireCanonicalEffectSchemaImport,
    "sort-destructure-keys": sortDestructureKeys,
  },
};
