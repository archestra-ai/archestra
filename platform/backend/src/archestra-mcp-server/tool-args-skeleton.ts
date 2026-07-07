/**
 * Schema-derived placeholder skeletons for tool arguments — the single home
 * for "show the model the shape it should have sent". Consumed by run_tool's
 * third-party pre-check (run-tool.ts) and the archestra validation-error
 * result (index.ts), so both surfaces teach one shape.
 */

/**
 * Illustrative placeholder for a value, derived from its declared JSON Schema.
 * Prefers a concrete literal (`const`, first `enum` member); otherwise reads
 * only literal `properties`/`required`/`items` (mirroring the shallow validation)
 * and recurses into object/array shapes up to MAX_SKELETON_DEPTH. A `type` array
 * (e.g. `["string","null"]`) resolves to its first non-null member. Falls back to
 * an opaque type tag for free-form objects, `$ref`/`allOf`/`oneOf`/`anyOf`, or
 * past the depth cap — the full schema appended to the error carries the rest.
 */
export function placeholderForSchema(schema: unknown, depth: number): string {
  if (!isRecord(schema)) {
    return "<value>";
  }
  if ("const" in schema) {
    return safeJsonStringify(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return safeJsonStringify(schema.enum[0]);
  }
  if (
    "$ref" in schema ||
    "allOf" in schema ||
    "oneOf" in schema ||
    "anyOf" in schema
  ) {
    return "<value>";
  }
  const types = Array.isArray(schema.type)
    ? schema.type.filter((t): t is string => typeof t === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  const primaryType = types.find((t) => t !== "null") ?? types[0];
  switch (primaryType) {
    case "string":
      return "<string>";
    case "number":
    case "integer":
      return "<number>";
    case "boolean":
      return "<boolean>";
    case "null":
      return "null";
    case "array": {
      if (depth < MAX_SKELETON_DEPTH && isRecord(schema.items)) {
        return `[${placeholderForSchema(schema.items, depth + 1)}]`;
      }
      return "<array>";
    }
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : null;
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (key): key is string => typeof key === "string",
          )
        : [];
      if (depth < MAX_SKELETON_DEPTH && properties && required.length > 0) {
        const entries = required.map(
          (key) =>
            `${JSON.stringify(key)}: ${placeholderForSchema(properties[key], depth + 1)}`,
        );
        return `{${entries.join(", ")}}`;
      }
      return "<object>";
    }
    default:
      return "<value>";
  }
}

/**
 * Full top-level parameter skeleton of a tool's JSON input schema: every
 * declared property rendered as a placeholder, plus the literal `required`
 * names. Null when the schema declares no readable properties.
 */
export function toolParamsSkeleton(
  jsonSchema: unknown,
): { skeleton: string; required: string[] } | null {
  if (!isRecord(jsonSchema) || !isRecord(jsonSchema.properties)) {
    return null;
  }
  const properties = jsonSchema.properties;
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    return null;
  }
  const entries = keys.map(
    (key) =>
      `${JSON.stringify(key)}: ${placeholderForSchema(properties[key], 1)}`,
  );
  const required = Array.isArray(jsonSchema.required)
    ? jsonSchema.required.filter(
        (key): key is string => typeof key === "string",
      )
    : [];
  return { skeleton: `{${entries.join(", ")}}`, required };
}

/**
 * JSON.stringify that never throws — the diagnostic path serializes
 * model-supplied tool_args and a catalog schema, either of which could carry a
 * BigInt or a circular reference. A failure must not turn a validation error
 * into an exception, so fall back to an opaque marker.
 */
export function safeJsonStringify(value: unknown, indent?: number): string {
  try {
    return (
      JSON.stringify(
        value,
        (_key, v) => (typeof v === "bigint" ? v.toString() : v),
        indent,
      ) ?? "<unserializable>"
    );
  } catch {
    return "<unserializable>";
  }
}

// === Internal helpers ===

/** How many levels of object/array nesting a skeleton unpacks before falling
 * back to an opaque tag. Generous: this runs only on an already-failed call, so
 * a fuller skeleton beats a terser one — the cap is just a guard against a
 * pathologically deep schema (`$ref` cycles already bail above). */
const MAX_SKELETON_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
