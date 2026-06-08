// Gemini's tool/function schema validation only permits `enum` on string-typed
// fields. JSON schemas produced upstream (e.g. `@ai-sdk/google` rewrites a zod
// `const: true` into `enum: [true]`) can carry boolean/number enums, which Gemini
// rejects with 400 INVALID_ARGUMENT. This sanitizer walks a tool parameter schema
// and removes non-string enums while preserving the value type, folding the dropped
// literal(s) into the field description so the model keeps the hint.

type SchemaObject = Record<string, unknown>;

// keywords whose value is a single subschema (recurse only when it is an object)
const SINGLE_SUBSCHEMA_KEYS = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
] as const;

// keywords whose value is a map of named subschemas
const SUBSCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

// keywords whose value is an array of subschemas
const SUBSCHEMA_ARRAY_KEYS = [
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
] as const;

export function sanitizeGeminiToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiToolSchema);
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  const result: SchemaObject = { ...(schema as SchemaObject) };
  normalizeEnum(result);
  recurseSubschemas(result);
  return result;
}

function normalizeEnum(node: SchemaObject): void {
  const enumValues = node.enum;
  if (!Array.isArray(enumValues)) return;
  if (enumValues.length > 0 && enumValues.every((v) => typeof v === "string")) {
    return;
  }

  delete node.enum;

  if (node.type === undefined && enumValues.length > 0) {
    node.type = inferType(enumValues[0]);
  }

  if (enumValues.length > 0) {
    node.description = appendConstraint(node.description, enumValues);
  }
}

function recurseSubschemas(node: SchemaObject): void {
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = node[key];
    if (map !== null && typeof map === "object" && !Array.isArray(map)) {
      const sanitized: SchemaObject = {};
      for (const [name, sub] of Object.entries(map)) {
        sanitized[name] = sanitizeGeminiToolSchema(sub);
      }
      node[key] = sanitized;
    }
  }

  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const arr = node[key];
    if (Array.isArray(arr)) {
      node[key] = arr.map(sanitizeGeminiToolSchema);
    }
  }

  // `items` and `additionalItems` may be a single subschema or an array of them
  for (const key of ["items", "additionalItems"] as const) {
    const value = node[key];
    if (Array.isArray(value)) {
      node[key] = value.map(sanitizeGeminiToolSchema);
    } else if (value !== null && typeof value === "object") {
      node[key] = sanitizeGeminiToolSchema(value);
    }
  }

  for (const key of SINGLE_SUBSCHEMA_KEYS) {
    const value = node[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      node[key] = sanitizeGeminiToolSchema(value);
    }
  }
}

function inferType(value: unknown): string {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return Array.isArray(value) ? "array" : "object";
    default:
      return "string";
  }
}

function appendConstraint(description: unknown, values: unknown[]): string {
  const rendered = values.map((v) => `\`${JSON.stringify(v)}\``);
  const note =
    rendered.length === 1
      ? `Value must be ${rendered[0]}.`
      : `Value must be one of: ${rendered.join(", ")}.`;
  return typeof description === "string" && description.length > 0
    ? `${description} ${note}`
    : note;
}
