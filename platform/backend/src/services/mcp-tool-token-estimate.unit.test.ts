import { describe, expect, test } from "vitest";
import { estimateMcpToolTokens } from "./mcp-tool-token-estimate";

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
