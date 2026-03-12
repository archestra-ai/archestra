// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { vi } from "vitest";
import { queryService } from "@/knowledge-base";
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

  test("query_knowledge_sources calls queryService with correct params when KB is assigned", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const agentWithKb = await makeAgent({
      name: "Agent With KB",
      organizationId: org.id,
      knowledgeBaseIds: [kb.id],
    });

    const mockResults = [
      {
        chunkId: "chunk-1",
        content: "This is a relevant document",
        score: 0.95,
        metadata: { source: "test.md" },
      },
    ];

    const querySpy = vi
      .spyOn(queryService, "query")
      .mockResolvedValueOnce(mockResults as any);

    const contextWithOrg: ArchestraContext = {
      agent: { id: agentWithKb.id, name: agentWithKb.name },
      organizationId: org.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
      { query: "relevant document" },
      contextWithOrg,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.totalChunks).toBe(1);
    expect(parsed.results).toEqual(mockResults);

    // Verify queryService.query was called with correct parameters
    expect(querySpy).toHaveBeenCalledOnce();
    const callArgs = querySpy.mock.calls[0][0];
    expect(callArgs.connectorIds).toContain(connector.id);
    expect(callArgs.organizationId).toBe(org.id);
    expect(callArgs.queryText).toBe("relevant document");
    expect(callArgs.limit).toBe(10);

    querySpy.mockRestore();
  });

  test("query_knowledge_sources returns error when no connectors found for KB", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    // Create a KB with NO connectors
    const kb = await makeKnowledgeBase(org.id);

    const agentWithEmptyKb = await makeAgent({
      name: "Agent With Empty KB",
      organizationId: org.id,
      knowledgeBaseIds: [kb.id],
    });

    const contextWithOrg: ArchestraContext = {
      agent: { id: agentWithEmptyKb.id, name: agentWithEmptyKb.name },
      organizationId: org.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
      { query: "test query" },
      contextWithOrg,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No connectors found for the assigned knowledge bases",
    );
  });

  test("query_knowledge_sources calls queryService with correct params for direct connector assignment (no KB)", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    // Create a KB + connector so the connector exists in the DB
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // Create agent with ONLY a direct connector assignment (no KB)
    const agentWithConnector = await makeAgent({
      name: "Agent With Direct Connector",
      organizationId: org.id,
      connectorIds: [connector.id],
    });

    const mockResults = [
      {
        chunkId: "chunk-1",
        content: "Direct connector result",
        score: 0.9,
        metadata: { source: "jira" },
      },
    ];

    const querySpy = vi
      .spyOn(queryService, "query")
      .mockResolvedValueOnce(mockResults as any);

    const contextWithOrg: ArchestraContext = {
      agent: { id: agentWithConnector.id, name: agentWithConnector.name },
      organizationId: org.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
      { query: "jira tickets" },
      contextWithOrg,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.totalChunks).toBe(1);
    expect(parsed.results).toEqual(mockResults);

    // Verify queryService.query was called with the direct connector ID
    expect(querySpy).toHaveBeenCalledOnce();
    const callArgs = querySpy.mock.calls[0][0];
    expect(callArgs.connectorIds).toContain(connector.id);
    expect(callArgs.organizationId).toBe(org.id);
    expect(callArgs.queryText).toBe("jira tickets");

    querySpy.mockRestore();
  });

  test("query_knowledge_sources returns error when organizationId is missing", async ({
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    await makeKnowledgeBaseConnector(kb.id, org.id);

    const agentWithKb = await makeAgent({
      name: "Agent No OrgCtx",
      organizationId: org.id,
      knowledgeBaseIds: [kb.id],
    });

    const contextNoOrg: ArchestraContext = {
      agent: { id: agentWithKb.id, name: agentWithKb.name },
      // no organizationId
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
      { query: "test query" },
      contextNoOrg,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Organization context not available",
    );
  });
});
