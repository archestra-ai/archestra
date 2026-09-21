import { describe, expect, test } from "vitest";
import { getAllArchestraMcpTools } from "@/archestra-mcp-server";
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
