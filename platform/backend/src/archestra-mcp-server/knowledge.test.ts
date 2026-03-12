// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./knowledge";

describe("knowledge tools", () => {
  test("should have query_knowledge_sources tool", () => {
    const tool = tools.find((t) => t.name.endsWith("query_knowledge_sources"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Query Knowledge Sources");
    expect(tool?.inputSchema.required).toContain("query");
  });
});

describe("knowledge tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("query_knowledge_sources returns error when query is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "query parameter is required",
    );
  });

  test("query_knowledge_sources returns error when no knowledge base assigned", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
      { query: "test query" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No knowledge base or connector assigned",
    );
  });
});
