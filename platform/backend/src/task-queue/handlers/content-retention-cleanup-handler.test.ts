import { vi } from "vitest";

vi.mock("@/logging");

import { count, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { ConversationModel, MessageModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";
// biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
import { handleContentRetentionCleanup } from "./content-retention-cleanup-handler.ee";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

const minimalRequest = {
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: "hello" }],
} as unknown as InteractionRequest;

const minimalResponse = {
  id: "resp",
  content: [{ type: "text", text: "hi" }],
} as unknown as InteractionResponse;

async function seedInteraction(overrides: {
  createdAt: Date;
  parentId?: string;
  sessionId?: string;
  threadId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(schema.interactionsTable)
    .values({
      request: minimalRequest,
      response: minimalResponse,
      type: "anthropic:messages",
      createdAt: overrides.createdAt,
      parentId: overrides.parentId ?? null,
      sessionId: overrides.sessionId ?? null,
      threadId: overrides.threadId ?? null,
    })
    .returning({ id: schema.interactionsTable.id });
  return row.id;
}

async function seedMcpToolCall(createdAt: Date): Promise<void> {
  await db.insert(schema.mcpToolCallsTable).values({
    mcpServerName: "test-server",
    method: "tools/call",
    createdAt,
  });
}

async function countRows(
  table:
    | typeof schema.interactionsTable
    | typeof schema.mcpToolCallsTable
    | typeof schema.conversationsTable
    | typeof schema.messagesTable
    | typeof schema.filesTable,
): Promise<number> {
  const [{ total }] = await db.select({ total: count() }).from(table);
  return Number(total);
}

describe("handleContentRetentionCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.retention.llmLogsDays = 0;
    config.retention.mcpLogsDays = 0;
    config.retention.chatConversationsDays = 0;
  });

  test("no-op when all retention windows are disabled", async () => {
    await seedInteraction({ createdAt: daysAgo(400) });
    await seedMcpToolCall(daysAgo(400));

    await handleContentRetentionCleanup();

    expect(await countRows(schema.interactionsTable)).toBe(1);
    expect(await countRows(schema.mcpToolCallsTable)).toBe(1);
  });

  test("deletes expired interactions but keeps rows within the window", async () => {
    config.retention.llmLogsDays = 30;
    await seedInteraction({ createdAt: daysAgo(45) });
    await seedInteraction({ createdAt: daysAgo(5) });

    await handleContentRetentionCleanup();

    expect(await countRows(schema.interactionsTable)).toBe(1);
  });

  test("erodes an expired delta chain without violating the parent FK", async () => {
    config.retention.llmLogsDays = 30;
    // head <- mid <- tip, all expired: leaf-first deletion must remove the
    // whole chain (tip first) without ever tripping ON DELETE RESTRICT.
    const head = await seedInteraction({
      createdAt: daysAgo(90),
      sessionId: "s1",
      threadId: "t1",
    });
    const mid = await seedInteraction({
      createdAt: daysAgo(80),
      parentId: head,
      sessionId: "s1",
      threadId: "t1",
    });
    await seedInteraction({
      createdAt: daysAgo(70),
      parentId: mid,
      sessionId: "s1",
      threadId: "t1",
    });

    await handleContentRetentionCleanup();

    expect(await countRows(schema.interactionsTable)).toBe(0);
  });

  test("retains expired ancestors of a fresh delta row", async () => {
    config.retention.llmLogsDays = 30;
    // head (old) <- tip (fresh): the old head is the delta base of a live
    // row and must survive so reconstruction cannot truncate.
    const head = await seedInteraction({
      createdAt: daysAgo(90),
      sessionId: "s2",
      threadId: "t2",
    });
    await seedInteraction({
      createdAt: daysAgo(1),
      parentId: head,
      sessionId: "s2",
      threadId: "t2",
    });
    // Unrelated expired row still ages out in the same sweep.
    await seedInteraction({ createdAt: daysAgo(90) });

    await handleContentRetentionCleanup();

    expect(await countRows(schema.interactionsTable)).toBe(2);
    const [survivingHead] = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, head));
    expect(survivingHead).toBeDefined();
  });

  test("deletes expired mcp tool calls but keeps rows within the window", async () => {
    config.retention.mcpLogsDays = 30;
    await seedMcpToolCall(daysAgo(31));
    await seedMcpToolCall(daysAgo(29));

    await handleContentRetentionCleanup();

    expect(await countRows(schema.mcpToolCallsTable)).toBe(1);
  });

  test("deletes idle conversations with their messages and no-project file rows", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    config.retention.chatConversationsDays = 180;
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const [expired] = await db
      .insert(schema.conversationsTable)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "old",
        lastMessageAt: daysAgo(200),
      })
      .returning();
    await db.insert(schema.messagesTable).values({
      id: crypto.randomUUID(),
      conversationId: expired.id,
      role: "user",
      content: { parts: [{ type: "text", text: "old message" }] },
    });
    await db.insert(schema.filesTable).values({
      organizationId: org.id,
      userId: user.id,
      conversationId: expired.id,
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      storageProvider: "db",
      data: Buffer.from("abc"),
    });

    const [active] = await db
      .insert(schema.conversationsTable)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "fresh",
        lastMessageAt: daysAgo(2),
      })
      .returning();

    await handleContentRetentionCleanup();

    expect(await countRows(schema.conversationsTable)).toBe(1);
    expect(await countRows(schema.messagesTable)).toBe(0);
    // File ROWS are purged, not orphaned with a nulled conversation id.
    expect(await countRows(schema.filesTable)).toBe(0);
    const [remaining] = await db
      .select({ id: schema.conversationsTable.id })
      .from(schema.conversationsTable);
    expect(remaining.id).toBe(active.id);
  });

  test("a soft-deleted (trashed) conversation still expires — trash never extends lifetime", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    config.retention.chatConversationsDays = 180;
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const [trashed] = await db
      .insert(schema.conversationsTable)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "trashed and old",
        lastMessageAt: daysAgo(200),
      })
      .returning();
    await db.insert(schema.messagesTable).values({
      id: crypto.randomUUID(),
      conversationId: trashed.id,
      role: "user",
      content: { parts: [{ type: "text", text: "old trashed message" }] },
    });
    await ConversationModel.delete(trashed.id, user.id, org.id);

    // Soft-deleted but recent: stays restorable, retention must not touch it.
    await db.insert(schema.conversationsTable).values({
      id: crypto.randomUUID(),
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "trashed but fresh",
      lastMessageAt: daysAgo(2),
      deletedAt: new Date(),
    });

    await handleContentRetentionCleanup();

    expect(await countRows(schema.conversationsTable)).toBe(1);
    expect(await countRows(schema.messagesTable)).toBe(0);
    const [remaining] = await db
      .select({ title: schema.conversationsTable.title })
      .from(schema.conversationsTable);
    expect(remaining.title).toBe("trashed but fresh");
  });

  test("a conversation revived after selection survives the sweep", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    config.retention.chatConversationsDays = 180;
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const [conversation] = await db
      .insert(schema.conversationsTable)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "revived",
        lastMessageAt: daysAgo(200),
      })
      .returning();

    // A message lands before the sweep runs — MessageModel.create advances
    // lastMessageAt atomically, so the under-lock recheck must skip the row.
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: { parts: [{ type: "text", text: "still here" }] },
    });

    await handleContentRetentionCleanup();

    expect(await countRows(schema.conversationsTable)).toBe(1);
    expect(await countRows(schema.messagesTable)).toBe(1);
  });

  test("one table's failure does not stop the other sweeps", async () => {
    config.retention.llmLogsDays = 30;
    config.retention.mcpLogsDays = 30;
    await seedMcpToolCall(daysAgo(31));

    const spy = vi
      .spyOn((await import("@/models")).InteractionModel, "deleteExpired")
      .mockRejectedValueOnce(new Error("boom"));

    await handleContentRetentionCleanup();

    expect(await countRows(schema.mcpToolCallsTable)).toBe(0);
    spy.mockRestore();
  });
});
