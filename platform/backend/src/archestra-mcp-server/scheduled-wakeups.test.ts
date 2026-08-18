// biome-ignore-all lint/suspicious/noExplicitAny: test

import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { ConversationModel, ScheduleTriggerModel } from "@/models";
import { describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

/**
 * The scheduled-wakeup tools: the model schedules future turns in the current
 * conversation as `schedule_triggers` rows. Guard rails — one of at/cron, a
 * 5-minute cron floor, a per-conversation cap, and locked-chat refusal — are
 * the contract under test, plus (conversation, actor) scoping on list/cancel.
 */
describe("scheduled wakeup tools", () => {
  async function setup(fixtures: {
    makeOrganization: any;
    makeUser: any;
    makeMember: any;
    makeAgent: any;
    seedAndAssignArchestraTools: any;
  }) {
    const org = await fixtures.makeOrganization();
    const user = await fixtures.makeUser();
    await fixtures.makeMember(user.id, org.id, { role: "admin" });
    const agent = await fixtures.makeAgent({
      name: "Wakeup Agent",
      agentType: "agent",
      organizationId: org.id,
    });
    await fixtures.seedAndAssignArchestraTools(agent.id);
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "wakeups",
    });
    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    };
    return { org, user, agent, conversation, context };
  }

  const call = (
    tool: string,
    args: Record<string, unknown>,
    context: ArchestraContext,
  ) => executeArchestraTool(`archestra__${tool}`, args, context);

  test("schedules, lists, and cancels a one-shot wakeup targeting the current conversation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { user, agent, conversation, context } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });

    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    const created = await call(
      "schedule_wakeup",
      { prompt: "Check the deploy status and report back.", at },
      context,
    );
    expect(created.isError).toBe(false);
    const wakeup = (created.structuredContent as any).wakeup;
    expect(wakeup.recurring).toBe(false);
    expect(wakeup.enabled).toBe(true);

    // The row targets this conversation, agent, and actor.
    const [row] = await db
      .select()
      .from(schema.scheduleTriggersTable)
      .where(eq(schema.scheduleTriggersTable.id, wakeup.wakeupId));
    expect(row.conversationId).toBe(conversation.id);
    expect(row.agentId).toBe(agent.id);
    expect(row.actorUserId).toBe(user.id);
    expect(row.cronExpression).toBeNull();
    expect(row.runAt).not.toBeNull();

    const listed = await call("list_scheduled_wakeups", {}, context);
    expect((listed.structuredContent as any).wakeups).toHaveLength(1);

    const cancelled = await call(
      "cancel_scheduled_wakeup",
      { wakeupId: wakeup.wakeupId },
      context,
    );
    expect((cancelled.structuredContent as any).cancelled).toBe(true);
    expect(await ScheduleTriggerModel.findById(wakeup.wakeupId)).toBeNull();
  });

  test("validates its guard rails", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { context } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    const both = await call(
      "schedule_wakeup",
      { prompt: "p", at: future, cron: "0 9 * * *" },
      context,
    );
    expect(both.isError).toBe(true);
    expect((both.content[0] as any).text).toContain("exactly one");

    const neither = await call("schedule_wakeup", { prompt: "p" }, context);
    expect(neither.isError).toBe(true);

    const past = await call(
      "schedule_wakeup",
      { prompt: "p", at: new Date(Date.now() - 60_000).toISOString() },
      context,
    );
    expect(past.isError).toBe(true);
    expect((past.content[0] as any).text).toContain("future");

    const tooFrequent = await call(
      "schedule_wakeup",
      { prompt: "p", cron: "* * * * *" },
      context,
    );
    expect(tooFrequent.isError).toBe(true);
    expect((tooFrequent.content[0] as any).text).toContain("5 minutes");

    const badTimezone = await call(
      "schedule_wakeup",
      { prompt: "p", at: future, timezone: "Mars/Olympus" },
      context,
    );
    expect(badTimezone.isError).toBe(true);

    const noConversation = await call(
      "schedule_wakeup",
      { prompt: "p", at: future },
      { ...context, conversationId: undefined },
    );
    expect(noConversation.isError).toBe(true);
    expect((noConversation.content[0] as any).text).toContain(
      "interactive chat conversations",
    );
  });

  test("refuses locked chats and enforces the per-conversation cap", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { conversation, context } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    // Fill the cap.
    for (let i = 0; i < 10; i++) {
      const result = await call(
        "schedule_wakeup",
        { prompt: `check #${i}`, at: future },
        context,
      );
      expect(result.isError).toBe(false);
    }
    const overCap = await call(
      "schedule_wakeup",
      { prompt: "one too many", at: future },
      context,
    );
    expect(overCap.isError).toBe(true);
    expect((overCap.content[0] as any).text).toContain("maximum");

    await db
      .update(schema.conversationsTable)
      .set({ lockedChat: true })
      .where(eq(schema.conversationsTable.id, conversation.id));
    const locked = await call(
      "schedule_wakeup",
      { prompt: "p", at: future },
      context,
    );
    expect(locked.isError).toBe(true);
    expect((locked.content[0] as any).text).toContain("locked");
  });

  test("list and cancel are scoped to the caller's own wakeups on the conversation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    seedAndAssignArchestraTools,
  }) => {
    const { org, agent, conversation, context } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    // Another user's wakeup on the same conversation (defensive scenario).
    const otherUser = await makeUser();
    const theirs = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: otherUser.id,
      cronExpression: null,
      runAt: new Date(Date.now() + 60 * 60_000),
      conversationId: conversation.id,
    });

    const listed = await call("list_scheduled_wakeups", {}, context);
    expect((listed.structuredContent as any).wakeups).toHaveLength(0);

    const cancelled = await call(
      "cancel_scheduled_wakeup",
      { wakeupId: theirs.id },
      context,
    );
    expect((cancelled.structuredContent as any).cancelled).toBe(false);
    expect(await ScheduleTriggerModel.findById(theirs.id)).not.toBeNull();
  });
});
