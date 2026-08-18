// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { ConversationModel } from "@/models";
import McpGatewayTaskModel from "@/models/mcp-gateway-task";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("chat tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      agentType: "agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
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
      "Validation error in archestra__todo_write",
    );
    expect((result.content[0] as any).text).toContain("todos:");
  });

  test("background task tools require a chat conversation context", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_background_tasks`,
      {},
      mockContext, // no conversationId
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "interactive chat conversations",
    );
  });

  test("list_background_tasks lists only the caller's harness tasks for the conversation, and cancel_background_task cancels a working one", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const conversation = await ConversationModel.create({
      userId: mockContext.userId as string,
      organizationId: mockContext.organizationId as string,
      agentId: testAgent.id,
      title: "bg tasks",
    });
    const contextWithConversation: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
      agentId: testAgent.id,
    };
    const principal = `user:${mockContext.userId}`;

    const mine = await McpGatewayTaskModel.create({
      agentId: testAgent.id,
      principal,
      toolName: "agent__helper",
      ttlMs: 60_000,
      conversationId: conversation.id,
      context: { kind: "delegation", targetAgentName: "Helper" },
    });
    // A plain gateway task (no harness context) in the same conversation
    // scope must not be listed.
    await McpGatewayTaskModel.create({
      agentId: testAgent.id,
      principal,
      toolName: "lab__slow",
      ttlMs: 60_000,
      conversationId: conversation.id,
    });
    // Someone else's harness task must not be listed either.
    await McpGatewayTaskModel.create({
      agentId: testAgent.id,
      principal: "user:someone-else",
      toolName: "agent__helper",
      ttlMs: 60_000,
      conversationId: conversation.id,
      context: { kind: "delegation", targetAgentName: "Helper" },
    });

    const listResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_background_tasks`,
      {},
      contextWithConversation,
    );
    expect(listResult.isError).toBe(false);
    const listed = (listResult.structuredContent as any).tasks;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      taskId: mine.id,
      status: "working",
      kind: "delegation",
      agentName: "Helper",
      settledAt: null,
    });

    const cancelResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}cancel_background_task`,
      { taskId: mine.id },
      contextWithConversation,
    );
    expect(cancelResult.isError).toBe(false);
    expect((cancelResult.structuredContent as any).cancelled).toBe(true);

    // Cancelling again reports nothing to cancel (already terminal).
    const cancelAgain = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}cancel_background_task`,
      { taskId: mine.id },
      contextWithConversation,
    );
    expect((cancelAgain.structuredContent as any).cancelled).toBe(false);
  });

  test("cancel_background_task cannot cancel another principal's task", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(testAgent.id);
    const conversation = await ConversationModel.create({
      userId: mockContext.userId as string,
      organizationId: mockContext.organizationId as string,
      agentId: testAgent.id,
      title: "bg tasks authz",
    });
    const theirs = await McpGatewayTaskModel.create({
      agentId: testAgent.id,
      principal: "user:someone-else",
      toolName: "agent__helper",
      ttlMs: 60_000,
      conversationId: conversation.id,
      context: { kind: "delegation", targetAgentName: "Helper" },
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}cancel_background_task`,
      { taskId: theirs.id },
      {
        ...mockContext,
        conversationId: conversation.id,
        agentId: testAgent.id,
      },
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).cancelled).toBe(false);
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
    expect(result.structuredContent).toEqual({ success: true, todoCount: 2 });
    expect((result.content[0] as any).text).toContain(
      "Successfully wrote 2 todo item(s)",
    );
  });
});
