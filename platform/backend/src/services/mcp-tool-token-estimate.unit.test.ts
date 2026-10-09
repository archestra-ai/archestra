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
  });

  test.each([
    ["x".repeat(2048), "x".repeat(2048)],
    ["x".repeat(2049), `${"x".repeat(2048)}… [truncated]`],
    [`${"x".repeat(2046)}…`, `${"x".repeat(2046)}..… [truncated]`],
    [`${"x".repeat(2047)}\u200dy`, `${"x".repeat(2047)}y`],
    [`${"x".repeat(2047)}😀tail`, `${"x".repeat(2047)}… [truncated]`],
  ])("normalizes before clipping at a safe UTF-16 boundary (case %#)", (description, expected) => {
    const [definition] = buildClaudeMcpToolDefinitions({
      serverName: "gateway",
      tools: [{ ...searchTool, description }],
    });
    expect(definition.description).toBe(expected);
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

  test("generic estimates keep full descriptions and ignore Claude server prefixes", () => {
    const estimate = (description: string) =>
      estimateMcpToolTokens({
        client: "generic",
        serverName: "gateway",
        tools: [{ ...searchTool, description }],
      })[0];

    expect(
      estimateMcpToolTokens({
        client: "generic",
        serverName: "a different Claude prefix",
        tools: [searchTool],
      }),
    ).toEqual([32]);
    expect(estimate("Search records. ".repeat(2000))).toBeGreaterThan(
      estimate("Search records. ".repeat(200)),
    );
  });
});
