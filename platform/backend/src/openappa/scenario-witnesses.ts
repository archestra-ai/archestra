import { asRecord, parsePolicyToml } from "./policy-text";

type ScenarioWitness = {
  tool: string;
  arguments: Record<string, unknown>;
};

const argumentName = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const safeArgumentName = (key: string) =>
  argumentName.test(key) &&
  !["__proto__", "constructor", "prototype"].includes(key);
const canonicalName = /^[a-z][a-z0-9_-]*\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/** Proposes examples only. Native replay, never this parser, decides outcomes. */
export function scenarioWitnesses(content: string) {
  const document = parsePolicyToml(content);
  const policy = asRecord(document?.policy);
  const aliases = asRecord(document?.server_aliases);
  const entries = Array.isArray(policy?.tool) ? policy.tool : [];
  const calls: ScenarioWitness[] = [];
  const skipped: { rule: string; reason: string }[] = [];
  const seen = new Set<string>();
  let examined = 0;
  for (const value of entries.slice(0, 64)) {
    if (calls.length >= 16) break;
    examined++;
    const entry = asRecord(value);
    if (!entry || typeof entry.name !== "string") continue;
    const rule = entry.name;
    // No invented tool identities for wildcard or provider-run declarations.
    const parts = /^([^()]+)(?:\(([^()]+)\))?$/.exec(rule);
    if (!parts || parts[1].includes("*")) {
      skipped.push({
        rule,
        reason: "Discovery needs a concrete tool identity.",
      });
      continue;
    }
    let tool = parts[1];
    if (/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_.-]+$/.test(tool))
      tool = `mcp/${tool.replace("__", "/")}`;
    if (!canonicalName.test(tool)) {
      skipped.push({
        rule,
        reason: "Discovery does not support this tool spelling.",
      });
      continue;
    }
    try {
      const schema = asRecord(entry.parameters) ?? { type: "object" };
      const args = asRecord(witness(schema, 0));
      if (!args) throw new Error("Concrete object arguments are needed.");
      for (const clause of parts[2]?.split(",") ?? []) {
        const selector =
          /^([a-zA-Z_][a-zA-Z0-9_-]*):([a-zA-Z0-9_./-]*\*?)$/.exec(clause);
        if (!selector)
          throw new Error(
            "Discovery does not support this selector expression.",
          );
        const [, key, pattern] = selector;
        if (!safeArgumentName(key))
          throw new Error("Concrete argument names are needed.");
        if (pattern === "*") {
          const property = asRecord(asRecord(schema.properties)?.[key]);
          args[key] ??= witness(property ?? { type: "string" }, 0);
        } else
          args[key] = pattern.endsWith("*")
            ? `${pattern.slice(0, -1)}example`
            : pattern;
      }
      if (Object.keys(args).some((key) => !safeArgumentName(key)))
        throw new Error("This argument name cannot be written by discovery.");
      const [family, namespace, leaf] = tool.split("/");
      const bindings = family === "mcp" ? aliases?.[namespace] : undefined;
      const names = Array.isArray(bindings) ? bindings : [namespace];
      for (const binding of names.slice(0, 16)) {
        if (calls.length >= 16) break;
        if (typeof binding !== "string") continue;
        const name = `${family}/${binding}/${leaf}`;
        if (!canonicalName.test(name)) continue;
        const call = { tool: name, arguments: args };
        const key = JSON.stringify(call);
        if (!seen.has(key) && key.length <= 8192) {
          seen.add(key);
          calls.push(call);
        }
      }
    } catch (error) {
      skipped.push({
        rule,
        reason:
          error instanceof Error
            ? error.message
            : "Concrete arguments are needed.",
      });
    }
  }
  return {
    calls,
    skipped,
    examined,
    limited: examined < entries.length || calls.length >= 16,
  };
}

function witness(schema: Record<string, unknown>, depth: number): unknown {
  if (depth > 4)
    throw new Error(
      "Discovery stops at nested schemas deeper than four levels.",
    );
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (
    [
      "$ref",
      "oneOf",
      "anyOf",
      "allOf",
      "not",
      "pattern",
      "format",
      "patternProperties",
    ].some((key) => key in schema)
  )
    throw new Error(
      "Concrete arguments are needed for this schema; discovery does not synthesize them.",
    );
  switch (schema.type) {
    case undefined:
    case "object": {
      const properties = asRecord(schema.properties);
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.length > 16)
        throw new Error("Too many required arguments for bounded discovery.");
      const entries = required.map((key) => {
        if (typeof key !== "string" || !safeArgumentName(key))
          throw new Error("Concrete argument names are needed.");
        const property = asRecord(properties?.[key]);
        if (!property) throw new Error(`Provide a concrete value for ${key}.`);
        return [key, witness(property, depth + 1)];
      });
      return Object.fromEntries(entries);
    }
    case "string": {
      const length = Math.max(
        7,
        typeof schema.minLength === "number" ? schema.minLength : 0,
      );
      const max = typeof schema.maxLength === "number" ? schema.maxLength : 128;
      if (length > 128 || max < length)
        throw new Error("Provide a concrete string satisfying these limits.");
      return "example".padEnd(length, "x");
    }
    case "boolean":
      return false;
    case "null":
      return null;
    case "integer":
    case "number": {
      if (
        "multipleOf" in schema ||
        "exclusiveMinimum" in schema ||
        "exclusiveMaximum" in schema
      )
        throw new Error("Provide a number satisfying these constraints.");
      const value = Math.ceil(
        typeof schema.minimum === "number" ? schema.minimum : 0,
      );
      if (typeof schema.maximum === "number" && value > schema.maximum)
        throw new Error("Provide a number satisfying these limits.");
      return value;
    }
    case "array": {
      const count = Math.max(
        1,
        typeof schema.minItems === "number" ? schema.minItems : 0,
      );
      if (
        count > 3 ||
        (typeof schema.maxItems === "number" && count > schema.maxItems) ||
        schema.uniqueItems
      )
        throw new Error("Provide an array satisfying these constraints.");
      const item = asRecord(schema.items);
      if (!item) throw new Error("Concrete array items are needed.");
      return Array.from({ length: count }, () => witness(item, depth + 1));
    }
    default:
      throw new Error("Discovery does not synthesize this schema type.");
  }
}

export function scenarioContent(
  call: ScenarioWitness,
  decision: "allow" | "deny",
) {
  const args = Object.entries(call.arguments)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `# Preserve this exact ${decision} decision in a fresh offline session.\n${call.tool} ${args ? `{\n${args}\n}` : "{}"}\nexpect ${decision}\n`;
}
