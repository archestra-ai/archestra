// biome-ignore-all lint/suspicious/noExplicitAny: test
// biome-ignore-all lint/style/noNonNullAssertion: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent, KnowledgeBase, KnowledgeBaseConnector } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./knowledge-management";

const t = (name: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`;

// === Tool metadata tests ===

describe("knowledge-management tools", () => {
  const expectedTools = [
    { short: "create_knowledge_base", title: "Create Knowledge Base" },
    { short: "get_knowledge_bases", title: "Get Knowledge Bases" },
    { short: "get_knowledge_base", title: "Get Knowledge Base" },
    { short: "update_knowledge_base", title: "Update Knowledge Base" },
    { short: "delete_knowledge_base", title: "Delete Knowledge Base" },
    {
      short: "create_knowledge_connector",
      title: "Create Knowledge Connector",
    },
    { short: "get_knowledge_connectors", title: "Get Knowledge Connectors" },
    { short: "get_knowledge_connector", title: "Get Knowledge Connector" },
    {
      short: "update_knowledge_connector",
      title: "Update Knowledge Connector",
    },
    {
      short: "delete_knowledge_connector",
      title: "Delete Knowledge Connector",
    },
    {
      short: "assign_knowledge_connector_to_knowledge_base",
      title: "Assign Knowledge Connector to Knowledge Base",
    },
    {
      short: "unassign_knowledge_connector_from_knowledge_base",
      title: "Unassign Knowledge Connector from Knowledge Base",
    },
    {
      short: "assign_knowledge_base_to_agent",
      title: "Assign Knowledge Base to Agent",
    },
    {
      short: "unassign_knowledge_base_from_agent",
      title: "Unassign Knowledge Base from Agent",
    },
    {
      short: "assign_knowledge_connector_to_agent",
      title: "Assign Knowledge Connector to Agent",
    },
    {
      short: "unassign_knowledge_connector_from_agent",
      title: "Unassign Knowledge Connector from Agent",
    },
  ];

  for (const { short, title } of expectedTools) {
    test(`should have ${short} tool`, () => {
      const tool = tools.find((tool) => tool.name.endsWith(short));
      expect(tool).toBeDefined();
      expect(tool?.title).toBe(title);
    });
  }
});

// === Execution tests ===

describe("knowledge-management tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeOrganization }) => {
    const org = await makeOrganization();
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      organizationId: org.id,
    };
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
      expect((result.content[0] as any).text).toContain("name is required");
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
      expect((result.content[0] as any).text).toContain("id is required");
    });

    test("get_knowledge_base returns error for nonexistent id", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_base"),
        { id: "00000000-0000-0000-0000-000000000000" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });

    test("update_knowledge_base returns error when no fields provided", async () => {
      const result = await executeArchestraTool(
        t("update_knowledge_base"),
        { id: "some-id" },
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
        "name, connector_type, and config are required",
      );
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
      expect((result.content[0] as any).text).toContain("id is required");
    });

    test("get_knowledge_connector returns error for nonexistent id", async () => {
      const result = await executeArchestraTool(
        t("get_knowledge_connector"),
        { id: "00000000-0000-0000-0000-000000000000" },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });

    test("update_knowledge_connector returns error when no fields", async () => {
      const result = await executeArchestraTool(
        t("update_knowledge_connector"),
        { id: "some-id" },
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

      // Update
      const updateResult = await executeArchestraTool(
        t("update_knowledge_connector"),
        { id: created.id, name: "Updated Connector" },
        mockContext,
      );
      expect(updateResult.isError).toBe(false);
      expect((updateResult.content[0] as any).text).toContain(
        "Updated Connector",
      );

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
        "connector_id and knowledge_base_id are required",
      );
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
        "knowledge_base_id and agent_id are required",
      );
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
        "connector_id and agent_id are required",
      );
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
});
