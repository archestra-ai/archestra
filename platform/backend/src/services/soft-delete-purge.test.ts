import { eq, isNull } from "drizzle-orm";
import { describe, expect } from "vitest";
import db, { schema } from "@/database";
import { softDelete } from "@/database/soft-delete";
import { AgentModel, ConversationModel, DeletedItemModel } from "@/models";
import { purgeDeletedItem } from "@/services/soft-delete-purge";
import { test } from "@/test";

async function softDeleteAgent(agentId: string) {
  await softDelete(db, schema.agentsTable, eq(schema.agentsTable.id, agentId));
}

async function findDeleted(
  entityType: "agent" | "conversation",
  id: string,
  organizationId: string,
) {
  const item = await DeletedItemModel.findOne({
    entityType,
    id,
    organizationId,
  });
  if (!item) throw new Error(`expected ${entityType} ${id} to be soft-deleted`);
  return item;
}

describe("purgeDeletedItem", () => {
  test("removes the row and records the purge in the audit log", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Doomed Agent",
    });
    await softDeleteAgent(agent.id);

    const outcome = await purgeDeletedItem({
      item: await findDeleted("agent", agent.id, org.id),
      organizationId: org.id,
      actor: { type: "system" },
    });

    expect(outcome).toEqual({ status: "purged" });
    expect(
      await AgentModel.findDeletedByIdForOrganization(agent.id, org.id),
    ).toBeNull();

    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, agent.id));
    expect(audit.action).toBe("agent.purged");
    expect(audit.actorType).toBe("system");
    expect(audit.resourceName).toBe("Doomed Agent");
    // The row is gone, so `before` is the only surviving description of it.
    expect(audit.before).toMatchObject({ name: "Doomed Agent" });
    expect(audit.after).toBeNull();
  });

  test("attributes a manual purge to the admin who asked for it", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser({ email: "admin@test.com" });
    const agent = await makeAgent({ organizationId: org.id });
    await softDeleteAgent(agent.id);

    await purgeDeletedItem({
      item: await findDeleted("agent", agent.id, org.id),
      organizationId: org.id,
      actor: {
        type: "user",
        id: admin.id,
        name: admin.name,
        email: admin.email,
      },
    });

    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, agent.id));
    expect(audit.actorType).toBe("user");
    expect(audit.actorId).toBe(admin.id);
    expect(audit.actorEmail).toBe("admin@test.com");
  });

  test("drains interactions.profile_id instead of letting the delete rewrite it", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const interactions = await Promise.all([
      makeInteraction(agent.id),
      makeInteraction(agent.id),
      makeInteraction(agent.id),
    ]);
    await softDeleteAgent(agent.id);

    await purgeDeletedItem({
      item: await findDeleted("agent", agent.id, org.id),
      organizationId: org.id,
      actor: { type: "system" },
    });

    // The history survives the agent, detached — the same end state a plain
    // DELETE would reach through the FK, just without the long lock.
    const rows = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(isNull(schema.interactionsTable.profileId));
    expect(rows.map((row) => row.id).sort()).toEqual(
      interactions.map((interaction) => interaction.id).sort(),
    );
  });

  test("detaches a purged agent's conversations rather than deleting them", async ({
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
    });
    await softDeleteAgent(agent.id);

    await purgeDeletedItem({
      item: await findDeleted("agent", agent.id, org.id),
      organizationId: org.id,
      actor: { type: "system" },
    });

    const [row] = await db
      .select({ agentId: schema.conversationsTable.agentId })
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversation.id));
    expect(row).toBeDefined();
    expect(row.agentId).toBeNull();
  });

  test("leaves a row that was restored between listing and the purge", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    await softDeleteAgent(agent.id);
    const item = await findDeleted("agent", agent.id, org.id);

    // The window this closes: an admin restores the agent after the sweep built
    // its work list. The hard delete is scoped to still-deleted rows, so it
    // finds nothing and the live agent survives.
    await AgentModel.restore(agent.id);

    const outcome = await purgeDeletedItem({
      item,
      organizationId: org.id,
      actor: { type: "system" },
    });

    expect(outcome).toEqual({ status: "skipped" });
    expect(await AgentModel.findById(agent.id)).not.toBeNull();
  });

  test("never reaches another organization's row", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    await softDeleteAgent(agent.id);
    const item = await findDeleted("agent", agent.id, org.id);

    const outcome = await purgeDeletedItem({
      item,
      organizationId: otherOrg.id,
      actor: { type: "system" },
    });

    expect(outcome).toEqual({ status: "skipped" });
    expect(
      await AgentModel.findDeletedByIdForOrganization(agent.id, org.id),
    ).not.toBeNull();
  });

  test("purges a conversation with its messages", async ({
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
    });
    await db.insert(schema.messagesTable).values({
      conversationId: conversation.id,
      role: "user",
      content: { type: "text", text: "hello" },
    });
    await ConversationModel.delete(
      conversation.id,
      conversation.userId,
      org.id,
    );

    await purgeDeletedItem({
      item: await findDeleted("conversation", conversation.id, org.id),
      organizationId: org.id,
      actor: { type: "system" },
    });

    const messages = await db
      .select({ id: schema.messagesTable.id })
      .from(schema.messagesTable)
      .where(eq(schema.messagesTable.conversationId, conversation.id));
    expect(messages).toHaveLength(0);
  });
});

describe("DeletedItemModel", () => {
  test("lists only soft-deleted rows of the caller's organization", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const deleted = await makeAgent({
      organizationId: org.id,
      name: "Deleted",
    });
    const active = await makeAgent({ organizationId: org.id, name: "Active" });
    const foreign = await makeAgent({
      organizationId: otherOrg.id,
      name: "Foreign",
    });
    await softDeleteAgent(deleted.id);
    await softDeleteAgent(foreign.id);

    const items = await DeletedItemModel.listForOrganization({
      organizationId: org.id,
      limit: 20,
      offset: 0,
    });

    expect(items.map((item) => item.id)).toEqual([deleted.id]);
    expect(items[0]).toMatchObject({
      entityType: "agent",
      name: "Deleted",
      restorable: true,
    });
    expect(items.map((item) => item.id)).not.toContain(active.id);
  });

  test("marks apps unrestorable so the UI never offers a broken restore", async ({
    makeOrganization,
    makeUser,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const app = await makeApp({
      organizationId: org.id,
      authorId: author.id,
      name: "Dashboard",
    });
    await softDelete(db, schema.appsTable, eq(schema.appsTable.id, app.id));

    const items = await DeletedItemModel.listForOrganization({
      organizationId: org.id,
      entityTypes: ["app"],
      limit: 20,
      offset: 0,
    });

    expect(items).toHaveLength(1);
    expect(items[0].restorable).toBe(false);
  });

  test("only lists rows deleted before the retention cutoff", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const old = await makeAgent({ organizationId: org.id });
    const recent = await makeAgent({ organizationId: org.id });
    await softDeleteAgent(old.id);
    await softDeleteAgent(recent.id);
    // Backdate one deletion past a 30-day window.
    await db
      .update(schema.agentsTable)
      .set({ deletedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.agentsTable.id, old.id));

    const purgeable = await DeletedItemModel.listPurgeableBefore({
      organizationId: org.id,
      entityType: "agent",
      before: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      limit: 50,
    });

    expect(purgeable).toEqual([old.id]);
  });

  test("drainReferences reports when a reference exceeds its batch budget", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    await Promise.all([
      makeInteraction(agent.id),
      makeInteraction(agent.id),
      makeInteraction(agent.id),
    ]);

    // One row per batch, two batches: the third interaction cannot be reached,
    // which is the signal the sweep uses to defer rather than start a delete it
    // cannot finish cheaply.
    const capped = await DeletedItemModel.drainReferences({
      table: schema.interactionsTable,
      column: schema.interactionsTable.profileId,
      value: agent.id,
      batchSize: 1,
      maxBatches: 2,
    });
    expect(capped).toEqual({ nulled: 2, drained: false });

    const rest = await DeletedItemModel.drainReferences({
      table: schema.interactionsTable,
      column: schema.interactionsTable.profileId,
      value: agent.id,
      batchSize: 10,
      maxBatches: 5,
    });
    expect(rest).toEqual({ nulled: 1, drained: true });

    const remaining = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, agent.id));
    expect(remaining).toEqual([]);
  });
});
