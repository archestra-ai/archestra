import { eq } from "drizzle-orm";
import { beforeEach, vi } from "vitest";
import db, { schema } from "@/database";
import { ConversationModel, MessageModel } from "@/models";
import McpGatewayTaskModel from "@/models/mcp-gateway-task";
import { chatBackgroundWork } from "@/services/chat-background-work";
import { mcpGatewayTaskReaper } from "@/services/mcp-gateway-task-reaper";
import { describe, expect, test } from "@/test";

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: vi.fn(),
}));

import { executeA2AMessage } from "@/agents/a2a-executor";

const executeMock = vi.mocked(executeA2AMessage);

/**
 * The chat background-work harness: delegations detach into durable task rows
 * carrying their conversation linkage, and settled outcomes come back as
 * persisted wake-notification messages. Delivery is row-driven so the reaper
 * can deliver for a dead replica, and locked chats are refused everywhere —
 * their content key only exists in the owner's browser.
 */
describe("chat background work", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  async function makeConversation(ctx: {
    makeUser: (overrides?: Record<string, unknown>) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
    makeAgent: (overrides?: Record<string, unknown>) => Promise<{ id: string }>;
  }) {
    const user = await ctx.makeUser();
    const org = await ctx.makeOrganization();
    const agent = await ctx.makeAgent();
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Background harness test",
    });
    return { user, org, agent, conversation };
  }

  function spawnParams(ctx: {
    conversationId: string;
    agentId: string;
    userId: string;
    organizationId: string;
  }) {
    return {
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      targetAgentId: ctx.agentId,
      targetAgentName: "Research Bot",
      toolName: "agent__research_bot",
      message: "go research",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
    };
  }

  test("detached delegation persists linkage on the task row and delivers a wake notification on settle", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, agent, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });

    let resolveRun: (v: Awaited<ReturnType<typeof executeA2AMessage>>) => void;
    executeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const spawned = await chatBackgroundWork.spawnDelegation(
      spawnParams({
        conversationId: conversation.id,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    );
    if (spawned.kind !== "task") throw new Error("expected a detached task");

    // The row carries everything a settle on any replica needs.
    const [row] = await db
      .select()
      .from(schema.mcpGatewayTasksTable)
      .where(eq(schema.mcpGatewayTasksTable.id, spawned.taskId));
    expect(row.conversationId).toBe(conversation.id);
    expect(row.context).toEqual({
      kind: "delegation",
      targetAgentName: "Research Bot",
    });
    // Background delegations outlive the 30-minute gateway default by design.
    const ttlMs = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(12 * 60 * 60 * 1000);

    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously by the mock
    resolveRun!({
      messageId: "m1",
      text: "the findings",
      finishReason: "stop",
      responseUiMessage: { id: "m1", role: "assistant", parts: [] },
    } as Awaited<ReturnType<typeof executeA2AMessage>>);

    await expect
      .poll(async () => {
        const messages = await MessageModel.findByConversation(conversation.id);
        return messages.length;
      })
      .toBe(1);

    const [notification] = await MessageModel.findByConversation(
      conversation.id,
    );
    expect(notification.role).toBe("user");
    expect(notification.content.id).toBe(`bg-task-${spawned.taskId}`);
    expect(notification.content.metadata.backgroundTask).toMatchObject({
      taskId: spawned.taskId,
      status: "completed",
      agentName: "Research Bot",
      toolName: "agent__research_bot",
    });
    expect(notification.content.parts[0].text).toContain("the findings");
  });

  test("a delegation finishing inside the threshold returns its result inline with no task row or notification", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, agent, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });
    executeMock.mockResolvedValue({
      messageId: "m1",
      text: "instant answer",
      finishReason: "stop",
      responseUiMessage: { id: "m1", role: "assistant", parts: [] },
    } as Awaited<ReturnType<typeof executeA2AMessage>>);

    const spawned = await chatBackgroundWork.spawnDelegation(
      spawnParams({
        conversationId: conversation.id,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    );

    expect(spawned).toEqual({ kind: "inline", resultText: "instant answer" });
    const messages = await MessageModel.findByConversation(conversation.id);
    expect(messages).toHaveLength(0);
  });

  test("a cancelled task delivers nothing", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, agent, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });

    let rejectRun: (err: Error) => void;
    executeMock.mockImplementation(
      (params) =>
        new Promise((_resolve, reject) => {
          rejectRun = reject;
          params.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const spawned = await chatBackgroundWork.spawnDelegation(
      spawnParams({
        conversationId: conversation.id,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    );
    if (spawned.kind !== "task") throw new Error("expected a detached task");

    // The user cancels through the row (any replica), then the run aborts.
    await McpGatewayTaskModel.cancelForPrincipal({
      taskId: spawned.taskId,
      principal: `user:${user.id}`,
    });
    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously by the mock
    rejectRun!(new Error("aborted"));

    await expect
      .poll(async () => {
        const [row] = await db
          .select()
          .from(schema.mcpGatewayTasksTable)
          .where(eq(schema.mcpGatewayTasksTable.id, spawned.taskId));
        return row.status;
      })
      .toBe("cancelled");
    // Give the settle callback a beat; it must not write anything.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
      0,
    );
  });

  test("spawn refuses locked chats up front", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, agent, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });
    await db
      .update(schema.conversationsTable)
      .set({ lockedChat: true })
      .where(eq(schema.conversationsTable.id, conversation.id));

    await expect(
      chatBackgroundWork.spawnDelegation(
        spawnParams({
          conversationId: conversation.id,
          agentId: agent.id,
          userId: user.id,
          organizationId: org.id,
        }),
      ),
    ).rejects.toThrow(/locked chats/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("delivery refuses a conversation that became locked after spawn", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, agent, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });

    let resolveRun: (v: Awaited<ReturnType<typeof executeA2AMessage>>) => void;
    executeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const spawned = await chatBackgroundWork.spawnDelegation(
      spawnParams({
        conversationId: conversation.id,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    );
    if (spawned.kind !== "task") throw new Error("expected a detached task");

    await db
      .update(schema.conversationsTable)
      .set({ lockedChat: true })
      .where(eq(schema.conversationsTable.id, conversation.id));

    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously by the mock
    resolveRun!({
      messageId: "m1",
      text: "secret findings",
      finishReason: "stop",
      responseUiMessage: { id: "m1", role: "assistant", parts: [] },
    } as Awaited<ReturnType<typeof executeA2AMessage>>);

    await expect
      .poll(async () => {
        const [row] = await db
          .select()
          .from(schema.mcpGatewayTasksTable)
          .where(eq(schema.mcpGatewayTasksTable.id, spawned.taskId));
        return row.status;
      })
      .toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing may be written into a locked conversation from the server side.
    expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
      0,
    );
  });

  test("the reaper delivers a failure notification for an expired linked task", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const { user, org, agent, conversation } = await makeConversation({
      makeUser,
      makeOrganization,
      makeAgent,
    });

    // A row whose executing replica died: linked, working, already expired.
    const task = await McpGatewayTaskModel.create({
      agentId: agent.id,
      principal: `user:${user.id}`,
      toolName: "agent__research_bot",
      ttlMs: -1_000,
      conversationId: conversation.id,
      context: { kind: "delegation", targetAgentName: "Research Bot" },
    });

    const swept = await mcpGatewayTaskReaper.sweep();
    expect(swept.failed).toBe(1);

    const messages = await MessageModel.findByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content.metadata.backgroundTask).toMatchObject({
      taskId: task.id,
      status: "failed",
      agentName: "Research Bot",
    });
    expect(messages[0].content.parts[0].text).toContain("failed");
  });

  test("an expired plain gateway task (no linkage) is reaped without any delivery", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await McpGatewayTaskModel.create({
      agentId: agent.id,
      principal: "user:someone",
      toolName: "slow-lab__slow_report",
      ttlMs: -1_000,
    });

    const swept = await mcpGatewayTaskReaper.sweep();
    expect(swept.failed).toBe(1);
    // No conversation exists to check; not throwing is the contract here.
  });
});
