// biome-ignore-all lint/suspicious/noExplicitAny: test
// biome-ignore-all lint/style/noNonNullAssertion: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { vi } from "vitest";
import { queryService } from "@/knowledge-base";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent, KnowledgeBase, KnowledgeBaseConnector } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const t = (name: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`;

// === Execution tests ===

describe("knowledge-management tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeOrganization, makeUser, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      organizationId: org.id,
      userId: user.id,
    };
  });

  // --- Query Knowledge Sources ---

  describe("query knowledge sources", () => {
    test("returns error when query is missing", async () => {
      const result = await executeArchestraTool(
        t("query_knowledge_sources"),
        {},
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__query_knowledge_sources",
      );
      expect((result.content[0] as any).text).toContain("query:");
    });

    test("returns error when no knowledge base assigned", async () => {
      const result = await executeArchestraTool(
        t("query_knowledge_sources"),
        { query: "test query" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "No knowledge base or connector assigned",
      );
    });

    test("calls queryService with correct params when KB is assigned", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeMember,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
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
        userId: user.id,
      };

      const result = await executeArchestraTool(
        t("query_knowledge_sources"),
        { query: "relevant document" },
        contextWithOrg,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        results: mockResults,
        totalChunks: 1,
      });
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.totalChunks).toBe(1);
      expect(parsed.results).toEqual(mockResults);

      expect(querySpy).toHaveBeenCalledOnce();
      const callArgs = querySpy.mock.calls[0][0];
      expect(callArgs.connectorIds).toContain(connector.id);
      expect(callArgs.organizationId).toBe(org.id);
      expect(callArgs.queryText).toBe("relevant document");
      expect(callArgs.limit).toBe(10);

      querySpy.mockRestore();
    });

    test("returns error when no connectors found for KB", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeMember,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const kb = await makeKnowledgeBase(org.id);

      const agentWithEmptyKb = await makeAgent({
        name: "Agent With Empty KB",
        organizationId: org.id,
        knowledgeBaseIds: [kb.id],
      });

      const contextWithOrg: ArchestraContext = {
        agent: { id: agentWithEmptyKb.id, name: agentWithEmptyKb.name },
        organizationId: org.id,
        userId: user.id,
      };

      const result = await executeArchestraTool(
        t("query_knowledge_sources"),
        { query: "test query" },
        contextWithOrg,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "No connectors found for the assigned knowledge bases",
      );
    });

    test("calls queryService with correct params for direct connector assignment", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeMember,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

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
        agent: {
          id: agentWithConnector.id,
          name: agentWithConnector.name,
        },
        organizationId: org.id,
        userId: user.id,
      };

      const result = await executeArchestraTool(
        t("query_knowledge_sources"),
        { query: "jira tickets" },
        contextWithOrg,
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.totalChunks).toBe(1);
      expect(parsed.results).toEqual(mockResults);

      expect(querySpy).toHaveBeenCalledOnce();
      const callArgs = querySpy.mock.calls[0][0];
      expect(callArgs.connectorIds).toContain(connector.id);
      expect(callArgs.organizationId).toBe(org.id);
      expect(callArgs.queryText).toBe("jira tickets");

      querySpy.mockRestore();
    });

    test("returns error when organizationId is missing", async ({
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
      };

      const result = await executeArchestraTool(
        t("query_knowledge_sources"),
        { query: "test query" },
        contextNoOrg,
      );
      expect(result.isError).toBe(true);
      // Centralized RBAC check catches missing user context before the handler
      expect((result.content[0] as any).text).toContain(
        "User context not available",
      );
    });
  });

  // --- Knowledge Base CRUD ---

  describe("knowledge base CRUD", () => {
    test("create_knowledge_base returns error when name missing", async () => {
      const result = await executeArchestraTool(
        t("create_knowledge_base"),
        {},
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__create_knowledge_base",
      );
      expect((result.content[0] as any).text).toContain("name:");
    });

    test("create_knowledge_base succeeds", async () => {
      const result = await executeArchestraTool(
        t("create_knowledge_base"),
        { name: "Test KB" },
        mockContext,
      );
      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Knowledge base created successfully",
      );
      expect((result.content[0] as any).text).toContain("Test KB");
    });

    test("get_knowledge_bases returns empty list", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_bases"),
        {},
        mockContext,
      );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ knowledgeBases: [] });
      expect((result.content[0] as any).text).toContain(
        "No knowledge bases found",
      );
    });

    test("get_knowledge_base returns error when id missing", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_base"),
        {},
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__get_knowledge_base",
      );
      expect((result.content[0] as any).text).toContain("id:");
    });

    test("get_knowledge_base returns error for nonexistent id", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_base"),
        { id: "00000000-0000-4000-8000-000000000001" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });

    test("update_knowledge_base returns error when no fields provided", async () => {
      const result = await executeArchestraTool(
        t("update_knowledge_base"),
        { id: "00000000-0000-4000-8000-000000000002" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("At least one field");
    });

    test("full knowledge base lifecycle", async () => {
      // Create
      const createResult = await executeArchestraTool(
        t("create_knowledge_base"),
        { name: "Lifecycle KB", description: "test desc" },
        mockContext,
      );
      expect(createResult.isError).toBe(false);
      const created = JSON.parse(
        (createResult.content[0] as any).text.split("\n\n")[1],
      );

      // Get
      const getResult = await executeArchestraTool(
        t("get_knowledge_base"),
        { id: created.id },
        mockContext,
      );
      expect(getResult.isError).toBe(false);
      const fetched = JSON.parse((getResult.content[0] as any).text);
      expect(fetched.name).toBe("Lifecycle KB");

      // List
      const listResult = await executeArchestraTool(
        t("get_knowledge_bases"),
        {},
        mockContext,
      );
      expect(listResult.isError).toBe(false);
      const list = JSON.parse((listResult.content[0] as any).text);
      expect(list.some((kb: any) => kb.id === created.id)).toBe(true);

      // Update
      const updateResult = await executeArchestraTool(
        t("update_knowledge_base"),
        { id: created.id, name: "Updated KB" },
        mockContext,
      );
      expect(updateResult.isError).toBe(false);
      expect((updateResult.content[0] as any).text).toContain("Updated KB");

      // Delete
      const deleteResult = await executeArchestraTool(
        t("delete_knowledge_base"),
        { id: created.id },
        mockContext,
      );
      expect(deleteResult.isError).toBe(false);
      expect((deleteResult.content[0] as any).text).toContain("deleted");

      // Verify deleted
      const verifyResult = await executeArchestraTool(
        t("get_knowledge_base"),
        { id: created.id },
        mockContext,
      );
      expect(verifyResult.isError).toBe(true);
      expect((verifyResult.content[0] as any).text).toContain("not found");
    });
  });

  // --- Knowledge Connector CRUD ---

  describe("knowledge connector CRUD", () => {
    test("create_knowledge_connector returns error when fields missing", async () => {
      const result = await executeArchestraTool(
        t("create_knowledge_connector"),
        { name: "test" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__create_knowledge_connector",
      );
      expect((result.content[0] as any).text).toContain("connector_type:");
      expect((result.content[0] as any).text).toContain("config:");
    });

    test("create_knowledge_connector succeeds", async () => {
      const result = await executeArchestraTool(
        t("create_knowledge_connector"),
        {
          name: "Test Connector",
          connector_type: "jira",
          config: {
            jiraBaseUrl: "https://test.atlassian.net",
            isCloud: true,
            projectKey: "TEST",
          },
        },
        mockContext,
      );
      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Knowledge connector created successfully",
      );
    });

    test("get_knowledge_connectors returns empty list", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_connectors"),
        {},
        mockContext,
      );
      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "No knowledge connectors found",
      );
    });

    test("get_knowledge_connector returns error when id missing", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_connector"),
        {},
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__get_knowledge_connector",
      );
      expect((result.content[0] as any).text).toContain("id:");
    });

    test("get_knowledge_connector returns error for nonexistent id", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_connector"),
        { id: "00000000-0000-4000-8000-000000000003" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });

    test("update_knowledge_connector returns error when no fields", async () => {
      const result = await executeArchestraTool(
        t("update_knowledge_connector"),
        { id: "00000000-0000-4000-8000-000000000004" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("At least one field");
    });

    test("full knowledge connector lifecycle", async () => {
      // Create
      const createResult = await executeArchestraTool(
        t("create_knowledge_connector"),
        {
          name: "Lifecycle Connector",
          connector_type: "jira",
          config: {
            jiraBaseUrl: "https://test.atlassian.net",
            isCloud: true,
            projectKey: "TEST",
          },
          description: "test connector",
        },
        mockContext,
      );
      expect(createResult.isError).toBe(false);
      const created = JSON.parse(
        (createResult.content[0] as any).text.split("\n\n")[1],
      );

      // Get
      const getResult = await executeArchestraTool(
        t("get_knowledge_connector"),
        { id: created.id },
        mockContext,
      );
      expect(getResult.isError).toBe(false);
      const fetched = JSON.parse((getResult.content[0] as any).text);
      expect(fetched.name).toBe("Lifecycle Connector");

      // List
      const listResult = await executeArchestraTool(
        t("get_knowledge_connectors"),
        {},
        mockContext,
      );
      expect(listResult.isError).toBe(false);
      const list = JSON.parse((listResult.content[0] as any).text);
      expect(list.some((c: any) => c.id === created.id)).toBe(true);

      // Update name
      const updateResult = await executeArchestraTool(
        t("update_knowledge_connector"),
        { id: created.id, name: "Updated Connector" },
        mockContext,
      );
      expect(updateResult.isError).toBe(false);
      expect((updateResult.content[0] as any).text).toContain(
        "Updated Connector",
      );

      // Update config
      const configUpdateResult = await executeArchestraTool(
        t("update_knowledge_connector"),
        {
          id: created.id,
          config: {
            type: "jira",
            jiraBaseUrl: "https://updated.atlassian.net",
            isCloud: true,
            projectKey: "UPDATED",
          },
        },
        mockContext,
      );
      expect(configUpdateResult.isError).toBe(false);

      // Delete
      const deleteResult = await executeArchestraTool(
        t("delete_knowledge_connector"),
        { id: created.id },
        mockContext,
      );
      expect(deleteResult.isError).toBe(false);
      expect((deleteResult.content[0] as any).text).toContain("deleted");

      // Verify deleted
      const verifyResult = await executeArchestraTool(
        t("get_knowledge_connector"),
        { id: created.id },
        mockContext,
      );
      expect(verifyResult.isError).toBe(true);
      expect((verifyResult.content[0] as any).text).toContain("not found");
    });
  });

  // --- Connector <-> KB Assignment ---

  describe("knowledge connector to knowledge base assignments", () => {
    let kb: KnowledgeBase;
    let connector: KnowledgeBaseConnector;

    beforeEach(async ({ makeKnowledgeBase, makeKnowledgeBaseConnector }) => {
      kb = await makeKnowledgeBase(mockContext.organizationId!);
      connector = await makeKnowledgeBaseConnector(
        kb.id,
        mockContext.organizationId!,
      );
    });

    test("assign returns error when fields missing", async () => {
      const result = await executeArchestraTool(
        t("assign_knowledge_connector_to_knowledge_base"),
        { connector_id: connector.id },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__assign_knowledge_connector_to_knowledge_base",
      );
      expect((result.content[0] as any).text).toContain("knowledge_base_id:");
    });

    test("unassign succeeds", async () => {
      // connector was assigned to kb by makeKnowledgeBaseConnector
      const result = await executeArchestraTool(
        t("unassign_knowledge_connector_from_knowledge_base"),
        { connector_id: connector.id, knowledge_base_id: kb.id },
        mockContext,
      );
      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("unassigned");
    });

    test("unassign returns error for nonexistent assignment", async () => {
      // Unassign first
      await executeArchestraTool(
        t("unassign_knowledge_connector_from_knowledge_base"),
        { connector_id: connector.id, knowledge_base_id: kb.id },
        mockContext,
      );
      // Try again
      const result = await executeArchestraTool(
        t("unassign_knowledge_connector_from_knowledge_base"),
        { connector_id: connector.id, knowledge_base_id: kb.id },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not assigned");
    });

    test("assign and unassign lifecycle", async () => {
      // Unassign existing
      await executeArchestraTool(
        t("unassign_knowledge_connector_from_knowledge_base"),
        { connector_id: connector.id, knowledge_base_id: kb.id },
        mockContext,
      );

      // Reassign
      const assignResult = await executeArchestraTool(
        t("assign_knowledge_connector_to_knowledge_base"),
        { connector_id: connector.id, knowledge_base_id: kb.id },
        mockContext,
      );
      expect(assignResult.isError).toBe(false);
      expect((assignResult.content[0] as any).text).toContain("assigned");

      // Unassign
      const unassignResult = await executeArchestraTool(
        t("unassign_knowledge_connector_from_knowledge_base"),
        { connector_id: connector.id, knowledge_base_id: kb.id },
        mockContext,
      );
      expect(unassignResult.isError).toBe(false);
      expect((unassignResult.content[0] as any).text).toContain("unassigned");
    });
  });

  // --- KB <-> Agent Assignment ---

  describe("knowledge base to agent assignments", () => {
    let kb: KnowledgeBase;

    beforeEach(async ({ makeKnowledgeBase }) => {
      kb = await makeKnowledgeBase(mockContext.organizationId!);
    });

    test("assign returns error when fields missing", async () => {
      const result = await executeArchestraTool(
        t("assign_knowledge_base_to_agent"),
        { knowledge_base_id: kb.id },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__assign_knowledge_base_to_agent",
      );
      expect((result.content[0] as any).text).toContain("agent_id:");
    });

    test("assign and unassign lifecycle", async () => {
      // Assign
      const assignResult = await executeArchestraTool(
        t("assign_knowledge_base_to_agent"),
        { knowledge_base_id: kb.id, agent_id: testAgent.id },
        mockContext,
      );
      expect(assignResult.isError).toBe(false);
      expect((assignResult.content[0] as any).text).toContain("assigned");

      // Unassign
      const unassignResult = await executeArchestraTool(
        t("unassign_knowledge_base_from_agent"),
        { knowledge_base_id: kb.id, agent_id: testAgent.id },
        mockContext,
      );
      expect(unassignResult.isError).toBe(false);
      expect((unassignResult.content[0] as any).text).toContain("unassigned");
    });

    test("unassign returns error for nonexistent assignment", async () => {
      const result = await executeArchestraTool(
        t("unassign_knowledge_base_from_agent"),
        { knowledge_base_id: kb.id, agent_id: testAgent.id },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not assigned");
    });
  });

  // --- Connector <-> Agent Assignment ---

  describe("knowledge connector to agent assignments", () => {
    let kb: KnowledgeBase;
    let connector: KnowledgeBaseConnector;

    beforeEach(async ({ makeKnowledgeBase, makeKnowledgeBaseConnector }) => {
      kb = await makeKnowledgeBase(mockContext.organizationId!);
      connector = await makeKnowledgeBaseConnector(
        kb.id,
        mockContext.organizationId!,
      );
    });

    test("assign returns error when fields missing", async () => {
      const result = await executeArchestraTool(
        t("assign_knowledge_connector_to_agent"),
        { connector_id: connector.id },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__assign_knowledge_connector_to_agent",
      );
      expect((result.content[0] as any).text).toContain("agent_id:");
    });

    test("assign and unassign lifecycle", async () => {
      // Assign
      const assignResult = await executeArchestraTool(
        t("assign_knowledge_connector_to_agent"),
        { connector_id: connector.id, agent_id: testAgent.id },
        mockContext,
      );
      expect(assignResult.isError).toBe(false);
      expect((assignResult.content[0] as any).text).toContain("assigned");

      // Unassign
      const unassignResult = await executeArchestraTool(
        t("unassign_knowledge_connector_from_agent"),
        { connector_id: connector.id, agent_id: testAgent.id },
        mockContext,
      );
      expect(unassignResult.isError).toBe(false);
      expect((unassignResult.content[0] as any).text).toContain("unassigned");
    });

    test("unassign returns error for nonexistent assignment", async () => {
      const result = await executeArchestraTool(
        t("unassign_knowledge_connector_from_agent"),
        { connector_id: connector.id, agent_id: testAgent.id },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not assigned");
    });
  });

  // --- RBAC enforcement ---

  describe("RBAC enforcement", () => {
    let memberContext: ArchestraContext;

    beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
      const org = await makeOrganization();
      const member = await makeUser();
      await makeMember(member.id, org.id, { role: "member" });
      memberContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        organizationId: org.id,
        userId: member.id,
      };
    });

    const mutationTools = [
      { tool: "create_knowledge_base", args: { name: "Test KB" } },
      { tool: "update_knowledge_base", args: { id: "x", name: "new" } },
      { tool: "delete_knowledge_base", args: { id: "x" } },
      {
        tool: "create_knowledge_connector",
        args: { name: "c", connector_type: "jira", config: {} },
      },
      { tool: "update_knowledge_connector", args: { id: "x", name: "new" } },
      { tool: "delete_knowledge_connector", args: { id: "x" } },
      {
        tool: "assign_knowledge_connector_to_knowledge_base",
        args: { connector_id: "x", knowledge_base_id: "y" },
      },
      {
        tool: "unassign_knowledge_connector_from_knowledge_base",
        args: { connector_id: "x", knowledge_base_id: "y" },
      },
      {
        tool: "assign_knowledge_base_to_agent",
        args: { knowledge_base_id: "x", agent_id: "y" },
      },
      {
        tool: "unassign_knowledge_base_from_agent",
        args: { knowledge_base_id: "x", agent_id: "y" },
      },
      {
        tool: "assign_knowledge_connector_to_agent",
        args: { connector_id: "x", agent_id: "y" },
      },
      {
        tool: "unassign_knowledge_connector_from_agent",
        args: { connector_id: "x", agent_id: "y" },
      },
    ];

    for (const { tool, args } of mutationTools) {
      test(`${tool} is denied for member without knowledgeBase permission`, async () => {
        const result = await executeArchestraTool(t(tool), args, memberContext);
        expect(result.isError).toBe(true);
        expect((result.content[0] as any).text).toContain(
          "do not have permission",
        );
      });
    }

    test("mutation without userId returns error", async () => {
      const noUserContext: ArchestraContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        organizationId: memberContext.organizationId,
      };
      const result = await executeArchestraTool(
        t("create_knowledge_base"),
        { name: "Test KB" },
        noUserContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "User context not available",
      );
    });
  });
});
