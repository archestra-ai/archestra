import { describe, expect, test } from "vitest";
import { z } from "zod";
import { getAllArchestraMcpTools } from "@/archestra-mcp-server";
import { NoticeArguments, RemedyExecutionSchema } from "@/openappa/notice";
import { normalizeToolInputSchema } from "./utils";

function assertNoNonStringConstOrEnum(schema: unknown): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("const" in record && typeof record.const !== "string") {
      throw new Error(`non-string const: ${JSON.stringify(record.const)}`);
    }
    if (
      Array.isArray(record.enum) &&
      record.enum.some((value) => typeof value !== "string")
    ) {
      throw new Error(`non-string enum: ${JSON.stringify(record.enum)}`);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(schema);
}

type SchemaPath = (string | number)[];

const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];
const SCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_SINGLE_KEYS = [
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
];
// Keywords that only describe a value, without narrowing what it may be.
const ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "default",
  "examples",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** Every subschema of a JSON Schema with its path, the root included. */
function schemaNodes(
  node: unknown,
  path: SchemaPath = [],
): [unknown, SchemaPath][] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return [[node, path]];
  }
  const record = node as Record<string, unknown>;
  const found: [unknown, SchemaPath][] = [[node, path]];
  for (const key of SCHEMA_MAP_KEYS) {
    const map = record[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [name, sub] of Object.entries(map)) {
        found.push(...schemaNodes(sub, [...path, key, name]));
      }
    }
  }
  for (const key of [...SCHEMA_LIST_KEYS, ...SCHEMA_SINGLE_KEYS]) {
    const value = record[key];
    if (Array.isArray(value)) {
      value.forEach((sub, index) => {
        found.push(...schemaNodes(sub, [...path, key, index]));
      });
    } else if (value !== undefined) {
      found.push(...schemaNodes(value, [...path, key]));
    }
  }
  return found;
}

function atPath(schema: unknown, path: SchemaPath): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node && typeof node === "object"
        ? (node as Record<string | number, unknown>)[key]
        : undefined,
    schema,
  );
}

function acceptsAnyValue(node: unknown): boolean {
  return (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    Object.keys(node).every((key) => ANNOTATION_KEYS.has(key))
  );
}

describe("normalizeToolInputSchema", () => {
  test("falls back to an empty object schema when the input is not an object schema", () => {
    expect(normalizeToolInputSchema(undefined)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeToolInputSchema({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("strips nested non-string const before tools/list advertisement", () => {
    const advertised = normalizeToolInputSchema({
      type: "object",
      properties: {
        notice: {
          type: "object",
          properties: {
            v: { type: "integer", const: 1 },
            custom: { type: "boolean", const: true },
          },
        },
      },
    });

    assertNoNonStringConstOrEnum(advertised);
    expect(advertised).toEqual({
      type: "object",
      properties: {
        notice: {
          type: "object",
          properties: {
            v: { type: "integer", description: "Value must be `1`." },
            custom: { type: "boolean", description: "Value must be `true`." },
          },
        },
      },
    });
  });

  test("OpenAPPA notice and execution Zod schemas advertise without Gemini-hostile literals", () => {
    const notice = normalizeToolInputSchema(
      z.toJSONSchema(NoticeArguments, { io: "input" }),
    ) as { properties?: Record<string, unknown> };
    const execution = normalizeToolInputSchema(
      z.toJSONSchema(
        z.object({ execution: RemedyExecutionSchema.optional() }),
        { io: "input" },
      ),
    ) as { properties?: Record<string, unknown> };

    expect(notice.properties?.tool).toBeDefined();
    expect(notice.properties?.notice).toBeDefined();
    expect(execution.properties?.execution).toBeDefined();
    assertNoNonStringConstOrEnum(notice);
    assertNoNonStringConstOrEnum(execution);
  });

  test("run_tool lets the model send any value in tool_args", () => {
    const runTool = getAllArchestraMcpTools().find((tool) =>
      tool.name.endsWith("run_tool"),
    );
    const advertised = normalizeToolInputSchema(
      runTool?.inputSchema,
    ) as unknown as {
      properties: { tool_args: Record<string, unknown> };
    };
    // Typed as an object, it made Kimi K3.1 send `limit: {}` for `limit: 10`.
    expect(advertised.properties.tool_args).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
  });

  test("every built-in MCP tool types every advertised schema node and keeps free values free", () => {
    for (const tool of getAllArchestraMcpTools()) {
      const advertised = normalizeToolInputSchema(tool.inputSchema);
      for (const [node, path] of schemaNodes(advertised)) {
        if (typeof node === "boolean") continue;
        const record = node as Record<string, unknown>;
        // Gemini rejects an untyped node, and Kimi Code types one as a string.
        expect(
          record.type !== undefined ||
            typeof record.$ref === "string" ||
            ["anyOf", "oneOf", "allOf"].some((key) =>
              Array.isArray(record[key]),
            ),
          `${tool.name} ${path.join(".")} has no type`,
        ).toBe(true);
      }
      for (const [node, path] of schemaNodes(tool.inputSchema)) {
        if (!acceptsAnyValue(node)) continue;
        const free = atPath(advertised, path) as
          | boolean
          | Record<string, unknown>;
        expect(
          free === true ||
            (typeof free === "object" &&
              Array.isArray(free.anyOf) &&
              free.anyOf.length > 2),
          `${tool.name} ${path.join(".")} must stay free, got ${JSON.stringify(free)}`,
        ).toBe(true);
      }
    }
  });

  test("every built-in MCP tool advertises a Gemini-safe input schema", () => {
    const tools = getAllArchestraMcpTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      try {
        assertNoNonStringConstOrEnum(
          normalizeToolInputSchema(tool.inputSchema),
        );
      } catch (error) {
        throw new Error(
          `${tool.name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  });
});
