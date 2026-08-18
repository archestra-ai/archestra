import { eq } from "drizzle-orm";
import { beforeEach, vi } from "vitest";
import db, { schema } from "@/database";
import { ConversationModel, MessageModel } from "@/models";
import McpGatewayTaskModel from "@/models/mcp-gateway-task";
import { chatBackgroundWork } from "@/services/chat-background-work";
import { conversationWakeService } from "@/services/conversation-wake";
import { mcpGatewayTaskReaper } from "@/services/mcp-gateway-task-reaper";
import { afterEach, describe, expect, test } from "@/test";

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
  const originalTimings = { ...conversationWakeService.timings };
  beforeEach(() => {
    executeMock.mockReset();
    // Shrink the wake grace/poll windows so headless fallbacks run (and
    // finish) within the test instead of lingering as background work.
    conversationWakeService.timings.idlePollMs = 10;
    conversationWakeService.timings.idleWaitDeadlineMs = 2_000;
    conversationWakeService.timings.headlessGraceMs = 40;
    conversationWakeService.timings.headlessGracePollMs = 10;
  });
  afterEach(() => {
    Object.assign(conversationWakeService.timings, originalTimings);
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
    executeMock.mockImplementation((execParams) => {
      if (execParams.messages !== undefined) {
        // The headless wake turn (prepared history, no current turn).
        return Promise.resolve({
          messageId: "wake-1",
          text: "relayed to the user",
          finishReason: "stop",
          responseUiMessage: {
            id: "wake-1",
            role: "assistant",
            parts: [{ type: "text", text: "relayed to the user" }],
          },
        } as Awaited<ReturnType<typeof executeA2AMessage>>);
      }
      // The detached delegation itself.
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

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

    // Notification persists first; with no browser claiming the wake turn
    // within the grace window, the headless fallback answers it.
    await expect
      .poll(
        async () => {
          const messages = await MessageModel.findByConversation(
            conversation.id,
          );
          return messages.length;
        },
        { timeout: 5_000 },
      )
      .toBe(2);

    const [notification, reply] = await MessageModel.findByConversation(
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
    // The headless turn saw the full history ending with the notification.
    const wakeCall = executeMock.mock.calls.find(
      ([p]) => p.messages !== undefined,
    );
    expect(wakeCall).toBeDefined();
    expect(reply.role).toBe("assistant");
    expect(reply.content.parts[0].text).toBe("relayed to the user");
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

  test("a task that outlives its TTL delivers exactly once: the settle owns it if it wins, the reaper if it flipped first", async ({
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
    executeMock.mockImplementation((execParams) => {
      if (execParams.messages !== undefined) {
        // Headless wake turns.
        return Promise.resolve({
          messageId: "wake",
          text: "ack",
          finishReason: "stop",
          responseUiMessage: {
            id: "wake",
            role: "assistant",
            parts: [{ type: "text", text: "ack" }],
          },
        } as Awaited<ReturnType<typeof executeA2AMessage>>);
      }
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    const spawned = await chatBackgroundWork.spawnDelegation(
      spawnParams({
        conversationId: conversation.id,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    );
    if (spawned.kind !== "task") throw new Error("expected a detached task");

    // The task outlives its TTL while genuinely still running…
    await db
      .update(schema.mcpGatewayTasksTable)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.mcpGatewayTasksTable.id, spawned.taskId));
    // …and the reaper flips it to failed and delivers the failure (plus the
    // headless wake reply).
    const swept = await mcpGatewayTaskReaper.sweep();
    expect(swept.failed).toBe(1);
    // Delivery is detached from the sweep; wait for it to land.
    await expect
      .poll(
        async () =>
          (await MessageModel.findByConversation(conversation.id)).length,
        { timeout: 5_000 },
      )
      .toBe(2);
    const afterReaper = await MessageModel.findByConversation(conversation.id);
    expect(afterReaper[0].content.metadata.backgroundTask.status).toBe(
      "failed",
    );

    // The live execution then finishes anyway. Its settle write loses to the
    // reaper's, so it must deliver NOTHING — no second notification.
    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously by the mock
    resolveRun!({
      messageId: "late",
      text: "late result",
      finishReason: "stop",
      responseUiMessage: { id: "late", role: "assistant", parts: [] },
    } as Awaited<ReturnType<typeof executeA2AMessage>>);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
      2,
    );
  });

  test("a task settling after its TTL but before the reaper still delivers its real outcome", async ({
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
    executeMock.mockImplementation((execParams) => {
      if (execParams.messages !== undefined) {
        return Promise.resolve({
          messageId: "wake",
          text: "ack",
          finishReason: "stop",
          responseUiMessage: {
            id: "wake",
            role: "assistant",
            parts: [{ type: "text", text: "ack" }],
          },
        } as Awaited<ReturnType<typeof executeA2AMessage>>);
      }
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    const spawned = await chatBackgroundWork.spawnDelegation(
      spawnParams({
        conversationId: conversation.id,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    );
    if (spawned.kind !== "task") throw new Error("expected a detached task");

    // Expired, but the reaper has not swept yet — the settle write still
    // wins the row, so the outcome is delivered (client-facing reads would
    // already refuse this row; delivery must not use their expiry filter).
    await db
      .update(schema.mcpGatewayTasksTable)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.mcpGatewayTasksTable.id, spawned.taskId));
    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously by the mock
    resolveRun!({
      messageId: "late",
      text: "the late findings",
      finishReason: "stop",
      responseUiMessage: { id: "late", role: "assistant", parts: [] },
    } as Awaited<ReturnType<typeof executeA2AMessage>>);

    await expect
      .poll(
        async () =>
          (await MessageModel.findByConversation(conversation.id)).length,
        { timeout: 5_000 },
      )
      .toBe(2);
    const [notification] = await MessageModel.findByConversation(
      conversation.id,
    );
    expect(notification.content.metadata.backgroundTask.status).toBe(
      "completed",
    );
    expect(notification.content.parts[0].text).toContain("the late findings");
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

    executeMock.mockResolvedValue({
      messageId: "wake-1",
      text: "sorry, it died",
      finishReason: "stop",
      responseUiMessage: {
        id: "wake-1",
        role: "assistant",
        parts: [{ type: "text", text: "sorry, it died" }],
      },
    } as Awaited<ReturnType<typeof executeA2AMessage>>);

    const swept = await mcpGatewayTaskReaper.sweep();
    expect(swept.failed).toBe(1);

    // Delivery is detached from the sweep; wait for it to land.
    await expect
      .poll(
        async () =>
          (await MessageModel.findByConversation(conversation.id)).length,
        { timeout: 5_000 },
      )
      .toBe(2);
    const messages = await MessageModel.findByConversation(conversation.id);
    expect(messages[0].content.metadata.backgroundTask).toMatchObject({
      taskId: task.id,
      status: "failed",
      agentName: "Research Bot",
    });
    expect(messages[0].content.parts[0].text).toContain("failed");
    // The wake turn ran headlessly (the reaper has no browser to lean on).
    expect(messages[1].role).toBe("assistant");
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
