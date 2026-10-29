// Gemini's tool/function schema validation only permits `enum` on string-typed
// fields. JSON schemas produced upstream (zod `z.literal(1)` / `z.literal(true)`,
// `@ai-sdk/google` rewriting `const: true` into `enum: [true]`) can carry
// boolean/number `const` or `enum` values. Clients that convert `const` into
// `enum` (and Gemini itself) then reject the whole tools payload with 400
// INVALID_ARGUMENT. This sanitizer walks a tool parameter schema, folds `const`
// into `enum`, and removes non-string enums while preserving the value type,
// putting the dropped literal(s) into the field description so the model keeps
// the hint. MCP `tools/list` uses the same pass so Gemini clients listing
// gateway tools never see a hostile schema.
//
// Gemini/Vertex also rejects schema nodes that carry no `type` at all ("schema
// didn't specify the schema type field"). MCP servers routinely emit such nodes —
// zod `z.unknown()` serializes to a bare `{}` — so the sanitizer infers a type
// from structural keywords. A node that accepts any value has no type to infer:
// a request to Gemini gets `object`, matching the fallback in Google's own SDKs.
// A schema that any model may receive (MCP `tools/list`) must keep the value
// free instead: "object" there tells every model to send an object, and models
// that follow the schema strictly turn a number into `{}`.

type SchemaObject = Record<string, unknown>;

/**
 * How the sanitizer writes a node that accepts any value. "object" is
 * Google's SDK fallback, for requests to Gemini. "any" keeps the value free
 * for every model and still gives every node a type: `true` as the value
 * schema of a map, otherwise a union of the JSON types.
 */
type AnyValueStyle = "object" | "any";

// keywords that make an untyped node an object, an array, a string or a number
const OBJECT_KEYWORDS = [
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
] as const;
const ARRAY_KEYWORDS = [
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "unevaluatedItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
] as const;
const STRING_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "contentEncoding",
  "contentMediaType",
] as const;
const NUMBER_KEYWORDS = ["minimum", "maximum", "multipleOf"] as const;

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
  "unevaluatedItems",
] as const;

// keywords whose value is a map of named subschemas
const SUBSCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  // draft-07 `dependencies` may hold subschemas (or property-name arrays, which
  // pass through the walk unchanged)
  "dependencies",
] as const;

// keywords whose value is an array of subschemas
const SUBSCHEMA_ARRAY_KEYS = [
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
] as const;

export function sanitizeGeminiToolSchema(
  schema: unknown,
  options: { anyValue?: AnyValueStyle } = {},
): unknown {
  return sanitizeNode(schema, options.anyValue ?? "object");
}

function sanitizeNode(schema: unknown, anyValue: AnyValueStyle): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeNode(item, anyValue));
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  const result: SchemaObject = { ...(schema as SchemaObject) };
  normalizeConst(result);
  normalizeEnum(result);
  normalizeExclusiveBounds(result);
  recurseSubschemas(result, anyValue);
  ensureNodeType(result, anyValue);
  return result;
}

// Gemini requires every schema node to declare a `type` (composites expressed
// via anyOf/oneOf/allOf are typed through their branches, and $ref nodes through
// their target). Infer one from structural keywords; a node with none of them
// accepts any value and is written as `anyValue` says.
function ensureNodeType(node: SchemaObject, anyValue: AnyValueStyle): void {
  if (node.type !== undefined || typeof node.$ref === "string") return;
  if (
    Array.isArray(node.anyOf) ||
    Array.isArray(node.oneOf) ||
    Array.isArray(node.allOf)
  ) {
    return;
  }

  if (hasAnyKey(node, OBJECT_KEYWORDS)) {
    node.type = "object";
    return;
  }
  if (hasAnyKey(node, ARRAY_KEYWORDS)) {
    node.type = "array";
    return;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    // normalizeEnum already ran: a surviving enum is all-string
    node.type = "string";
    return;
  }
  if (hasAnyKey(node, STRING_KEYWORDS)) {
    node.type = "string";
    return;
  }
  // normalizeExclusiveBounds already folded exclusive bounds into these
  if (hasAnyKey(node, NUMBER_KEYWORDS)) {
    node.type = "number";
    return;
  }
  if (anyValue === "any") {
    node.anyOf = anyJsonValue();
    return;
  }
  node.type = "object";
}

// Every JSON value except null, with every node typed: Gemini has no
// untyped "any", and Kimi Code types an untyped node as a string.
function anyJsonValue(): SchemaObject[] {
  const scalarsAndObjects = () => [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "object" },
  ];
  return [
    ...scalarsAndObjects(),
    { type: "array", items: { anyOf: scalarsAndObjects() } },
  ];
}

function hasAnyKey(node: SchemaObject, keys: readonly string[]): boolean {
  return keys.some((key) => node[key] !== undefined);
}

// A node that names no type, composite, reference, literal or keyword that
// narrows it, so it accepts any value.
function acceptsAnyValue(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const node = value as SchemaObject;
  return (
    node.type === undefined &&
    node.$ref === undefined &&
    node.anyOf === undefined &&
    node.oneOf === undefined &&
    node.allOf === undefined &&
    node.not === undefined &&
    node.if === undefined &&
    node.enum === undefined &&
    node.const === undefined &&
    !hasAnyKey(node, OBJECT_KEYWORDS) &&
    !hasAnyKey(node, ARRAY_KEYWORDS) &&
    !hasAnyKey(node, STRING_KEYWORDS) &&
    !hasAnyKey(node, NUMBER_KEYWORDS) &&
    node.exclusiveMinimum === undefined &&
    node.exclusiveMaximum === undefined
  );
}

// Zod and JSON Schema encode a single allowed value as `const`. Gemini has no
// `const` keyword; some clients (Kilo) rewrite it to `enum: [value]`, which
// then fails the string-enum rule for numbers and booleans. Treat `const` as a
// one-value enum so normalizeEnum can keep string literals and drop the rest.
function normalizeConst(node: SchemaObject): void {
  if (!Object.hasOwn(node, "const")) return;
  const value = node.const;
  delete node.const;
  if (!Array.isArray(node.enum)) {
    node.enum = [value];
  }
}

function normalizeEnum(node: SchemaObject): void {
  const enumValues = node.enum;
  if (!Array.isArray(enumValues)) return;
  if (enumValues.length > 0 && enumValues.every((v) => typeof v === "string")) {
    return;
  }

  delete node.enum;

  if (node.type === undefined && enumValues.length > 0) {
    node.type = inferType(enumValues);
  }

  if (enumValues.length > 0) {
    node.description = appendConstraint(node.description, enumValues);
  }
}

function normalizeExclusiveBounds(node: SchemaObject): void {
  normalizeExclusiveBound({
    node,
    exclusiveKey: "exclusiveMinimum",
    inclusiveKey: "minimum",
    comparison: "greater than",
  });
  normalizeExclusiveBound({
    node,
    exclusiveKey: "exclusiveMaximum",
    inclusiveKey: "maximum",
    comparison: "less than",
  });
}

function normalizeExclusiveBound(params: {
  node: SchemaObject;
  exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum";
  inclusiveKey: "minimum" | "maximum";
  comparison: "greater than" | "less than";
}): void {
  const { node, exclusiveKey, inclusiveKey, comparison } = params;
  const exclusiveValue = node[exclusiveKey];
  const bound =
    typeof exclusiveValue === "number"
      ? exclusiveValue
      : exclusiveValue === true && typeof node[inclusiveKey] === "number"
        ? node[inclusiveKey]
        : undefined;

  delete node[exclusiveKey];
  if (typeof bound !== "number") return;

  if (node[inclusiveKey] === undefined) {
    node[inclusiveKey] = bound;
  }
  node.description = appendDescription(
    node.description,
    `Value must be ${comparison} \`${bound}\`.`,
  );
}

function recurseSubschemas(node: SchemaObject, anyValue: AnyValueStyle): void {
  const sanitize = (sub: unknown) => sanitizeNode(sub, anyValue);
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = node[key];
    if (map !== null && typeof map === "object" && !Array.isArray(map)) {
      const sanitized: SchemaObject = {};
      for (const [name, sub] of Object.entries(map)) {
        sanitized[name] = sanitize(sub);
      }
      node[key] = sanitized;
    }
  }

  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const arr = node[key];
    if (Array.isArray(arr)) {
      node[key] = arr.map(sanitize);
    }
  }

  // `items` and `additionalItems` may be a single subschema or an array of them
  for (const key of ["items", "additionalItems"] as const) {
    const value = node[key];
    if (Array.isArray(value)) {
      node[key] = value.map(sanitize);
    } else if (value !== null && typeof value === "object") {
      node[key] = sanitize(value);
    }
  }

  for (const key of SINGLE_SUBSCHEMA_KEYS) {
    const value = node[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // A map whose values may be anything says so with `true`, which every
      // model reads, and which needs no type: it is not a schema node.
      const mapValue =
        key === "additionalProperties" || key === "unevaluatedProperties";
      node[key] =
        anyValue === "any" && mapValue && acceptsAnyValue(value)
          ? true
          : sanitize(value);
    }
  }
}

// Infer a single JSON-schema type for a dropped non-string enum. `string` is the
// safe fallback for empty/null-only/heterogeneous value sets (always valid for
// Gemini), so we only commit to a narrower type when every value agrees.
function inferType(values: unknown[]): string {
  const nonNull = values.filter((v) => v !== null);
  if (nonNull.length === 0) return "string";
  if (nonNull.every((v) => typeof v === "boolean")) return "boolean";
  if (nonNull.every((v) => typeof v === "number")) {
    return nonNull.every((v) => Number.isInteger(v)) ? "integer" : "number";
  }
  if (nonNull.every((v) => Array.isArray(v))) return "array";
  if (nonNull.every((v) => typeof v === "object")) return "object";
  return "string";
}

function appendConstraint(description: unknown, values: unknown[]): string {
  const rendered = values.map((v) =>
    typeof v === "string" ? `\`${v}\`` : `\`${JSON.stringify(v)}\``,
  );
  const note =
    rendered.length === 1
      ? `Value must be ${rendered[0]}.`
      : `Value must be one of: ${rendered.join(", ")}.`;
  return appendDescription(description, note);
}

function appendDescription(description: unknown, note: string): string {
  return typeof description === "string" && description.length > 0
    ? `${description} ${note}`
    : note;
}
