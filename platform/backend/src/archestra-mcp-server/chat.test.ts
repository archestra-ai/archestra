// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { OrganizationModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./chat";

describe("chat tools", () => {
  test("should have todo_write tool", () => {
    const tool = tools.find((t) => t.name.endsWith("todo_write"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Write Todos");
    expect(tool?.inputSchema.required).toContain("todos");
  });

  test("should have swap_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("swap_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Swap Agent");
    expect(tool?.inputSchema.required).toContain("agent_name");
  });

  test("should have swap_to_default_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("swap_to_default_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Swap to Default Agent");
    expect(tool?.inputSchema.required).toEqual([]);
  });

  test("should have artifact_write tool", () => {
    const tool = tools.find((t) => t.name.endsWith("artifact_write"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Write Artifact");
    expect(tool?.inputSchema.required).toContain("content");
  });
});

describe("chat tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let userId: string;
  let organizationId: string;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    userId = user.id;
    organizationId = org.id;
    testAgent = await makeAgent({
      name: "Test Agent",
      agentType: "agent",
      organizationId,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId,
      organizationId,
    };
  });

  test("todo_write returns error when todos is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "todos parameter is required",
    );
  });

  test("todo_write succeeds with valid todos", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {
        todos: [
          { id: 1, content: "Test task", status: "pending" },
          { id: 2, content: "Another task", status: "completed" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully wrote 2 todo item(s)",
    );
  });

  test("swap_agent returns error when agent_name is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "agent_name parameter is required",
    );
  });

  test("swap_agent returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "Some Agent" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("artifact_write returns error when content is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "content parameter is required",
    );
  });

  test("artifact_write returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# My Artifact" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("artifact_write succeeds with real conversation context", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# Test Artifact\n\nSome **markdown** content." },
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully updated conversation artifact",
    );
  });

  test("swap_agent succeeds with real conversation and target agent", async ({
    makeAgent,
    makeConversation,
  }) => {
    const targetAgent = await makeAgent({
      name: "Swap Target Agent",
      agentType: "agent",
      organizationId: organizationId,
    });

    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "Swap Target Agent" },
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.agent_id).toBe(targetAgent.id);
    expect(parsed.agent_name).toBe("Swap Target Agent");
  });

  test("swap_agent returns error when swapping to same agent", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: testAgent.name },
      contextWithConvo,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Already using agent");
  });

  test("swap_to_default_agent returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("swap_to_default_agent returns error when no default agent configured", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithConvo,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No default agent is configured",
    );
  });

  test("swap_to_default_agent succeeds when on non-default agent", async ({
    makeAgent,
    makeConversation,
  }) => {
    const defaultAgent = await makeAgent({
      name: "Default Router Agent",
      agentType: "agent",
      organizationId: organizationId,
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: defaultAgent.id,
    });

    const specialistAgent = await makeAgent({
      name: "Specialist Agent",
      agentType: "agent",
      organizationId: organizationId,
    });

    const conversation = await makeConversation(specialistAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      agent: { id: specialistAgent.id, name: specialistAgent.name },
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.agent_id).toBe(defaultAgent.id);
    expect(parsed.agent_name).toBe("Default Router Agent");
  });

  test("swap_to_default_agent returns error when already on default agent", async ({
    makeConversation,
  }) => {
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: testAgent.id,
    });

    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithConvo,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Already using the default agent",
    );
  });
});
