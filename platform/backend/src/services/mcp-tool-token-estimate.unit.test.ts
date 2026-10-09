import { describe, expect, test } from "vitest";
import {
  buildClaudeMcpToolDefinitions,
  estimateMcpToolTokens,
} from "./mcp-tool-token-estimate";

const searchTool = {
  name: "search",
  description: "Search records.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("estimateMcpToolTokens", () => {
  test("matches Claude's normalized, truncated tool serialization", () => {
    const [definition] = buildClaudeMcpToolDefinitions({
      serverName: "my gateway",
      tools: [
        {
          name: "ｓｅａｒｃｈ",
          description: `${"x".repeat(2047)}😀tail`,
          inputSchema: {
            properties: { ｑ: { type: "string", description: "Ａ\u200d" } },
            type: "object",
            $schema: "https://example.test/schema",
          },
        },
      ],
    });
    expect(definition.name).toBe("mcp__my_gateway__search");
    expect(definition.description).toBe(`${"x".repeat(2047)}… [truncated]`);
    expect(JSON.stringify(definition.input_schema)).toBe(
      '{"$schema":"https://example.test/schema","type":"object","properties":{"q":{"type":"string","description":"A"}}}',
    );
  });

  test("counts complete Claude definitions, reconciles rounding, and includes attestation bytes", () => {
    const params = {
      client: "claude-code" as const,
      serverName: "gateway",
      tools: [searchTool, searchTool],
    };
    expect(estimateMcpToolTokens(params)).toEqual([80, 80]);
    const marked = estimateMcpToolTokens({
      ...params,
      tools: [
        {
          ...searchTool,
          description: `[[gwa1.ZmFrZQ.AAAAAAAAAAAAAAAAAAAAAA]]\n${searchTool.description}`,
        },
      ],
    });
    expect(marked[0]).toBeGreaterThan(80);
  });

  test("generic estimates ignore Claude prefixes and retain full descriptions", () => {
    const estimate = (
      serverName: string,
      description = searchTool.description,
    ) =>
      estimateMcpToolTokens({
        client: "generic",
        serverName,
        tools: [{ ...searchTool, description }],
      });
    expect(estimate("gateway")).toEqual([32]);
    expect(estimate("other gateway")).toEqual(estimate("gateway"));
    expect(
      estimate("gateway", "Search records. ".repeat(2000))[0],
    ).toBeGreaterThan(estimate("gateway", "Search records. ".repeat(200))[0]);
  });
});
