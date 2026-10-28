import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import A2AContextModel from "./context";
import A2ATaskModel from "./task";
import A2ATaskApprovalRequestModel from "./task-approval-request";

describe("pending Jira chat approval lookup", () => {
  test("requires organization, exact bot channel/issue, pending task, reviewer and unexpired approval", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const agent = await makeAgent({
      organizationId: organization.id,
      agentType: "agent",
    });
    const reviewer = await makeUser();
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: reviewer.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_INPUT_REQUIRED",
    });
    const approvalId = randomUUID();
    const [approval] = await A2ATaskApprovalRequestModel.bulkCreateRaw([
      {
        taskId: task.id,
        approvalId,
        toolCallId: "synthetic-call",
        toolName: "example_tool",
        approved: false,
        resolved: false,
      },
    ]);
    const lookup = {
      organizationId: organization.id,
      channelId: "bot:10000",
      threadId: "20000",
    };
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread(lookup),
    ).toEqual([]);
    await A2ATaskApprovalRequestModel.attachChatReviewer({
      taskId: task.id,
      approvalId,
      userId: reviewer.id,
      channelId: lookup.channelId,
      threadId: lookup.threadId,
    });
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread(lookup),
    ).toMatchObject([{ id: approval.id, reviewerUserId: reviewer.id }]);
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread({
        ...lookup,
        organizationId: otherOrganization.id,
      }),
    ).toEqual([]);
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread({
        ...lookup,
        threadId: "20001",
      }),
    ).toEqual([]);
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread({
        ...lookup,
        channelId: "otherbot:10000",
      }),
    ).toEqual([]);
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread({
        ...lookup,
        approvalId: "another-approval",
      }),
    ).toEqual([]);
    await db
      .update(schema.a2aTaskApprovalRequestsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.a2aTaskApprovalRequestsTable.id, approval.id));
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread(lookup),
    ).toEqual([]);
    await db
      .update(schema.a2aTaskApprovalRequestsTable)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.a2aTaskApprovalRequestsTable.id, approval.id));
    await A2ATaskModel.updateState(task.id, "TASK_STATE_COMPLETED");
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread(lookup),
    ).toEqual([]);
  });

  test("returns two candidates so callers cannot approve ambiguous pending tools", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({
      organizationId: organization.id,
      agentType: "agent",
    });
    const reviewer = await makeUser();
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: reviewer.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_INPUT_REQUIRED",
    });
    const approvals = await A2ATaskApprovalRequestModel.bulkCreateRaw(
      ["first", "second"].map((approvalId) => ({
        taskId: task.id,
        approvalId,
        toolCallId: approvalId,
        toolName: "example_tool",
        approved: false,
        resolved: false,
        reviewerUserId: reviewer.id,
        chatChannelId: "bot:10000",
        chatThreadId: "20000",
      })),
    );
    const lookup = {
      organizationId: organization.id,
      channelId: "bot:10000",
      threadId: "20000",
    };
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread(lookup),
    ).toHaveLength(2);
    expect(
      await A2ATaskApprovalRequestModel.findPendingInChatThread({
        ...lookup,
        approvalId: approvals[0].approvalId,
      }),
    ).toHaveLength(1);
  });
});
