import logger from "@/logging";

/**
 * `x-mcp-header` (2026-07-28, SEP-2243): a server may annotate tool parameters
 * whose values a Streamable HTTP client mirrors into `Mcp-Param-{name}`
 * headers, so intermediaries can route on them without parsing bodies.
 *
 * The gateway is that client for every upstream call, and the spec puts two
 * obligations on it. A tool definition with an invalid annotation must be
 * rejected — excluded from `tools/list` with a warning, so one malformed tool
 * cannot poison the rest. And a valid annotation's value must be mirrored with
 * the exact encoding rules, because a sloppily-encoded header is an injection
 * vector, which is why most of this module is validation.
 */

/** @public — granular surface exercised directly by the unit suite */
export interface McpHeaderAnnotation {
  /** Chain of `properties` keys from the schema root to the annotated param. */
  path: string[];
  /** The name portion of the resulting `Mcp-Param-{name}` header. */
  name: string;
  type: "string" | "integer" | "boolean";
}

type AnnotationScan =
  | { ok: true; annotations: McpHeaderAnnotation[] }
  | { ok: false; reason: string };

/**
 * Collect and validate every `x-mcp-header` annotation in a tool input schema.
 *
 * Any violation invalidates the whole definition, per spec — including an
 * annotation in a position that is not statically reachable (through `items`,
 * composition keywords, conditionals, or `$ref`), which cannot be extracted
 * deterministically and therefore must not exist at all.
 */
/** @public — granular surface exercised directly by the unit suite */
export function collectMcpHeaderAnnotations(
  inputSchema: unknown,
): AnnotationScan {
  if (!isRecord(inputSchema)) return { ok: true, annotations: [] };

  const annotations: McpHeaderAnnotation[] = [];
  let failure: string | null = null;

  const fail = (reason: string): void => {
    if (!failure) failure = reason;
  };

  const visitSchema = (
    schema: unknown,
    path: string[],
    reachable: boolean,
  ): void => {
    if (failure || !isRecord(schema)) return;

    if ("x-mcp-header" in schema) {
      const name = schema["x-mcp-header"];
      if (!reachable) {
        fail(
          `x-mcp-header at ${path.join(".") || "<root>"} is not statically reachable`,
        );
        return;
      }
      if (typeof name !== "string" || name.length === 0) {
        fail(`x-mcp-header at ${path.join(".")} must be a non-empty string`);
        return;
      }
      // RFC 9110 field-name token syntax; excludes CR/LF and all controls.
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        fail(`x-mcp-header "${name}" is not a valid HTTP field-name token`);
        return;
      }
      const type = schema.type;
      if (type !== "string" && type !== "integer" && type !== "boolean") {
        // `number` is explicitly forbidden: its string form is not canonical.
        fail(
          `x-mcp-header "${name}" is on a parameter of type ${JSON.stringify(type)}; only string, integer, and boolean are permitted`,
        );
        return;
      }
      annotations.push({ path, name, type });
    }

    // `properties` keys are the only reachability-preserving step. Everything
    // else that nests schemas is walked so a stray annotation is FOUND, but
    // what it contains is not reachable.
    const { properties } = schema;
    if (isRecord(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        visitSchema(child, [...path, key], reachable);
      }
    }

    for (const keyword of [
      "items",
      "additionalProperties",
      "not",
      "if",
      "then",
      "else",
    ]) {
      if (keyword in schema) visitSchema(schema[keyword], path, false);
    }
    for (const keyword of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) {
        for (const branch of branches) visitSchema(branch, path, false);
      }
    }
    for (const keyword of ["$defs", "definitions", "patternProperties"]) {
      const map = schema[keyword];
      if (isRecord(map)) {
        for (const child of Object.values(map)) visitSchema(child, path, false);
      }
    }
  };

  visitSchema(inputSchema, [], true);
  if (failure) return { ok: false, reason: failure };

  // Case-insensitive uniqueness across every annotation in the schema: two
  // params mapping onto the same header would silently overwrite each other.
  const seen = new Map<string, string>();
  for (const { name } of annotations) {
    const key = name.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      return {
        ok: false,
        reason: `x-mcp-header values "${existing}" and "${name}" collide case-insensitively`,
      };
    }
    seen.set(key, name);
  }

  return { ok: true, annotations };
}

/**
 * Whether a tool definition must be excluded from `tools/list`.
 *
 * Logs the warning the spec asks for, naming the tool and the reason, so a
 * vanished tool is diagnosable rather than silently missing.
 */
export function isToolRejectedForMcpHeaders(params: {
  toolName: string;
  inputSchema: unknown;
}): boolean {
  const scan = collectMcpHeaderAnnotations(params.inputSchema);
  if (scan.ok) return false;
  logger.warn(
    { toolName: params.toolName, reason: scan.reason },
    "Excluding tool from tools/list: invalid x-mcp-header annotation",
  );
  return true;
}

/**
 * Build the `Mcp-Param-{name}` headers for one call.
 *
 * Extraction reads the instance value at the annotation's exact property path;
 * an absent value omits the header. A value that does not match the annotated
 * type is also omitted rather than coerced — the upstream will reject the
 * argument itself, and a coerced header could disagree with the body it
 * summarizes, which is the mismatch the routing headers exist to prevent.
 */
/** @public — granular surface exercised directly by the unit suite */
export function buildMcpParamHeaders(params: {
  annotations: McpHeaderAnnotation[];
  args: unknown;
}): Record<string, string> {
  const { annotations, args } = params;
  const headers: Record<string, string> = {};

  for (const annotation of annotations) {
    const value = readPath(args, annotation.path);
    if (value === undefined || value === null) continue;

    let text: string;
    if (annotation.type === "string" && typeof value === "string") {
      text = value;
    } else if (
      annotation.type === "integer" &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ) {
      text = String(value);
    } else if (annotation.type === "boolean" && typeof value === "boolean") {
      text = value ? "true" : "false";
    } else {
      logger.debug(
        { header: annotation.name, expected: annotation.type },
        "Skipping Mcp-Param header: argument value does not match annotated type",
      );
      continue;
    }

    headers[`Mcp-Param-${annotation.name}`] = encodeHeaderValue(text);
  }

  return headers;
}

/**
 * Compute the mirrored headers for a call in one step, or nothing when the
 * schema has no valid annotations. An invalid schema mirrors nothing: acting
 * on annotations from a definition the spec says to reject would be worse
 * than omitting the optimization.
 */
export function mcpParamHeadersForCall(params: {
  inputSchema: unknown;
  args: unknown;
}): Record<string, string> | undefined {
  const scan = collectMcpHeaderAnnotations(params.inputSchema);
  if (!scan.ok || scan.annotations.length === 0) return undefined;
  const headers = buildMcpParamHeaders({
    annotations: scan.annotations,
    args: params.args,
  });
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * RFC 9110 header values are visible ASCII plus interior space and tab. A
 * value outside that — or with leading/trailing whitespace, which header
 * parsing strips — is carried Base64-encoded in the spec's wrapper so it
 * round-trips exactly and can never smuggle CR/LF.
 */
function encodeHeaderValue(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching RFC 9110's exact allowed byte range (tab + space + visible ASCII) is the point
  const asciiSafe = /^[\x20\x09\x21-\x7E]*$/.test(value);
  const noEdgeWhitespace = value === value.trim();
  if (asciiSafe && noEdgeWhitespace) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
