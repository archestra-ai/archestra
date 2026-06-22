/**
 * Project the full OpenAPI document down to a compact, request-focused view for
 * agent-driven discovery (the `archestra__api` tool / Platform Operations skill).
 *
 * The canonical spec from `fastify.swagger()` is ~9MB: response schemas are
 * inlined per route rather than shared via `$ref`, so they dominate the bytes
 * (~87%). An agent administering the platform only needs, per operation, the
 * method/path, request shape, and which permission the route requires. This keeps
 * exactly that and drops responses, descriptions, and the unreferenced component
 * graph — turning a 9MB doc into a few KB per route group.
 *
 * Pure and deterministic: same input + options always yield the same output, so
 * it is served live (no committed snapshot to drift or re-seed).
 */

// === Exports ===

interface CompactOpenApiOptions {
  /** Restrict to operations whose path starts with this prefix, e.g. `/api/agents`. */
  pathPrefix?: string;
}

export function projectCompactOpenApi(
  doc: OpenApiDoc,
  options: CompactOpenApiOptions = {},
): OpenApiDoc {
  const prefix = options.pathPrefix?.startsWith("/api/")
    ? options.pathPrefix
    : undefined;

  const paths: Record<string, JsonObject> = {};
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    // The admin REST surface only — excludes the auth-skipping `/v1/*` proxies.
    if (!path.startsWith("/api/")) continue;
    if (prefix && !path.startsWith(prefix)) continue;
    if (!isJsonObject(item)) continue;

    const compactItem: JsonObject = {};
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method) || !isJsonObject(operation)) continue;
      compactItem[method] = pickFields(operation, KEPT_OPERATION_FIELDS);
    }
    if (Object.keys(compactItem).length > 0) paths[path] = compactItem;
  }

  const schemas = selectReferencedSchemas(paths, doc.components?.schemas ?? {});

  const result: OpenApiDoc = { openapi: doc.openapi, info: doc.info, paths };
  if (Object.keys(schemas).length > 0) result.components = { schemas };
  return result;
}

// === Types ===

type JsonObject = Record<string, unknown>;

/** @public — input/output shape, named only by tests (knip --production ignores those). */
export interface OpenApiDoc {
  openapi?: unknown;
  info?: unknown;
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}

// === Internal helpers ===

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

const KEPT_OPERATION_FIELDS = [
  "operationId",
  "summary",
  "parameters",
  "requestBody",
  "x-required-permissions",
];

function pickFields(source: JsonObject, fields: string[]): JsonObject {
  const out: JsonObject = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

/**
 * Walk the kept slice for `$ref`s into `#/components/schemas/*` and return the
 * transitive closure of referenced schemas, so the compact doc stays
 * self-contained without carrying the other ~60 unused component schemas.
 */
function selectReferencedSchemas(
  root: unknown,
  allSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const needed = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isJsonObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const name = schemaRefName(value);
        if (name !== null && !needed.has(name)) {
          needed.add(name);
          if (name in allSchemas) stack.push(allSchemas[name]);
        }
      } else {
        stack.push(value);
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const name of needed) {
    if (name in allSchemas) out[name] = allSchemas[name];
  }
  return out;
}

function schemaRefName(ref: string): string | null {
  const prefix = "#/components/schemas/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
