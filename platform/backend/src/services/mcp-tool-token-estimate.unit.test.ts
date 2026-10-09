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
  test("normalizes tool definitions but only escapes the configured server name", () => {
    const [definition] = buildClaudeMcpToolDefinitions({
      serverName: "Ｇａｔｅｗａｙ",
      tools: [
        {
          name: "ｒｅａｄ",
          description: "Ａ… a\u200d\u0301 \ud800x\udc00😀",
          inputSchema: {
            type: "object",
            properties: {
              ｑ: {
                enum: ["Ａ…", "a\u200db\ue000\u0378\ud800c\udc00😀"],
                description: "ASCII\n\t\u0001",
              },
            },
            required: ["ｑ"],
          },
        },
      ],
    });
    expect(definition).toEqual({
      name: "mcp___________read",
      description: "A... á x😀",
      input_schema: {
        type: "object",
        properties: {
          q: { enum: ["A...", "abc😀"], description: "ASCII\n\t\u0001" },
        },
        required: ["q"],
      },
    });
  });

  test("moves only the root schema's reserved fields and preserves nested schema order", () => {
    const inputSchema = {
      properties: { q: { description: "Query", type: "string" } },
      required: ["q"],
      type: "object",
      $schema: "https://example.test/schema",
    };
    const [definition] = buildClaudeMcpToolDefinitions({
      serverName: "gateway",
      tools: [{ ...searchTool, inputSchema }],
    });
    expect(JSON.stringify(definition.input_schema)).toBe(
      '{"$schema":"https://example.test/schema","type":"object","properties":{"q":{"description":"Query","type":"string"}},"required":["q"]}',
    );
    expect(Object.keys(inputSchema)).toEqual([
      "properties",
      "required",
      "type",
      "$schema",
    ]);
  });

  test("omits normalized prototype keys without changing other schema properties", () => {
    const [definition] = buildClaudeMcpToolDefinitions({
      serverName: "gateway",
      tools: [
        {
          ...searchTool,
          inputSchema: JSON.parse(
            '{"type":"object","properties":{"__proto__":{"type":"number"},"＿＿ｐｒｏｔｏ＿＿":{"type":"string"},"safe":{"type":"string"}}}',
          ),
        },
      ],
    });
    expect(JSON.stringify(definition.input_schema)).toBe(
      '{"type":"object","properties":{"safe":{"type":"string"}}}',
    );
  });

  test("normalizes description text before clipping and retains the generated suffix", () => {
    const definitions = buildClaudeMcpToolDefinitions({
      serverName: "gateway",
      tools: [
        { ...searchTool, description: `${"x".repeat(2046)}…` },
        { ...searchTool, description: `${"x".repeat(2047)}\u200dy` },
      ],
    });
    expect(definitions[0].description).toBe(
      `${"x".repeat(2046)}..… [truncated]`,
    );
    expect(definitions[1].description).toBe(`${"x".repeat(2047)}y`);
  });

  test("serializes the same ordered provider definitions for observation and fallback estimates", () => {
    const tools = [
      { ...searchTool, description: "x".repeat(3000) },
      { ...searchTool, name: "read" },
    ];
    const definitions = buildClaudeMcpToolDefinitions({
      tools,
      serverName: "gateway label",
    });
    expect(definitions.map((tool) => tool.name)).toEqual([
      "mcp__gateway_label__search",
      "mcp__gateway_label__read",
    ]);
    expect(definitions[0].description).toBe(`${"x".repeat(2048)}… [truncated]`);
    expect(definitions[0].input_schema).toEqual(searchTool.inputSchema);
    expect(
      estimateMcpToolTokens({
        tools,
        serverName: "gateway label",
        client: "claude-code",
      }).reduce((sum, count) => sum + count, 0),
    ).toBe(Math.round(JSON.stringify(definitions).length / 2));
  });
  test("counts complete Claude definitions and reconciles rounding across tools", () => {
    const tokens = estimateMcpToolTokens({
      client: "claude-code",
      serverName: "gateway",
      tools: [
        searchTool,
        {
          name: "read",
          description: "Read a record.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              options: {
                type: "object",
                properties: {
                  fields: { type: "array", items: { type: "string" } },
                },
              },
            },
            required: ["id"],
          },
        },
      ],
    });

    // The provider array is 405 UTF-16 code units, including the nested schema.
    expect(tokens).toEqual([80, 123]);
    expect(tokens.reduce((total, value) => total + value, 0)).toBe(203);
  });

  test("applies Claude's description limit only after the boundary", () => {
    const estimate = (description: string) =>
      estimateMcpToolTokens({
        client: "claude-code",
        serverName: "gateway",
        tools: [
          {
            name: "search",
            description,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });

    expect(estimate("x".repeat(2048))).toEqual([1074]);
    expect(estimate("x".repeat(2049))).toEqual([1080]);
    expect(estimate("x".repeat(20_000))).toEqual([1080]);
    // A cut between an emoji's surrogate pair must not emit an escaped orphan.
    expect(estimate(`${"x".repeat(2047)}😀tail`)).toEqual([1080]);
  });

  test("counts sanitized client aliases, including an absent description", () => {
    expect(
      estimateMcpToolTokens({
        client: "claude-code",
        serverName: "a\\b",
        tools: [
          {
            name: 'read"record',
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    ).toEqual([50]);
  });

  test.each([
    "claude-code",
    "generic",
  ] as const)("%s retains the gateway description marker in the client estimate", (client) => {
    const params = { client, serverName: "gateway", tools: [searchTool] };
    const plain = estimateMcpToolTokens(params);
    const marked = estimateMcpToolTokens({
      ...params,
      tools: [
        {
          ...searchTool,
          description: `[[gwa1.ZmFrZQ.AAAAAAAAAAAAAAAAAAAAAA]]\n${searchTool.description}`,
        },
      ],
    });
    expect(marked[0]).toBeGreaterThan(plain[0]);
  });

  test("generic estimates retain descriptions beyond Claude's client limit", () => {
    const estimate = (description: string) =>
      estimateMcpToolTokens({
        client: "generic",
        serverName: "gateway",
        tools: [{ ...searchTool, description }],
      })[0];

    expect(estimate("Search records. ".repeat(2000))).toBeGreaterThan(
      estimate("Search records. ".repeat(200)),
    );
  });

  test("generic estimates encode the complete tool definition", () => {
    expect(
      estimateMcpToolTokens({
        client: "generic",
        serverName: "gateway",
        tools: [searchTool],
      }),
    ).toEqual([32]);
  });

  test.each([
    "claude-code",
    "generic",
  ] as const)("%s reports no costs for an empty gateway", (client) => {
    expect(
      estimateMcpToolTokens({ client, serverName: "gateway", tools: [] }),
    ).toEqual([]);
  });
});
