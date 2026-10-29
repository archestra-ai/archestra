import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { clearRegisteredProcessLocalCaches } from "@/process-local-cache-registry";
import { describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { drainBackgroundWork } from "@/utils/background-work";
import { uuidv7 } from "@/utils/uuid";
import AgentModel from "./agent";
import InteractionModel from "./interaction";
import InteractionSessionHeadModel from "./interaction-session-head";

test("cursor pages preserve all-owner organization fences, user filters, and deleted-owner history", async ({
  makeOrganization,
  makeAgent,
  makeApp,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
  makeUser,
}) => {
  const org = await makeOrganization();
  const other = await makeOrganization();
  const user = await makeUser();
  const otherUser = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const deleted = await makeAgent({ organizationId: org.id });
  const foreign = await makeAgent({ organizationId: other.id });
  const app = await makeApp({ organizationId: org.id });
  const foreignApp = await makeApp({ organizationId: other.id });
  const kb = await makeKnowledgeBase(org.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
  const foreignKb = await makeKnowledgeBase(other.id);
  const foreignConnector = await makeKnowledgeBaseConnector(
    foreignKb.id,
    other.id,
  );
  const ownerships = [
    { profileId: agent.id },
    { profileId: null, appId: app.id },
    { profileId: null, connectorId: connector.id },
    { profileId: agent.id, appId: app.id, connectorId: connector.id },
    { profileId: deleted.id },
    { profileId: foreign.id },
    { profileId: agent.id, appId: foreignApp.id },
    { profileId: foreign.id, appId: app.id },
    { profileId: agent.id, connectorId: foreignConnector.id },
    { profileId: null, connectorId: connector.id, appId: foreignApp.id },
    { profileId: null },
    { profileId: agent.id, userId: otherUser.id },
  ];
  const expected: string[] = [];
  const now = Date.now();
  for (const [index, ownership] of ownerships.entries()) {
    const row = await InteractionModel.create({
      userId: user.id,
      ...ownership,
      type: "openai:chatCompletions",
      createdAt: new Date(now - index * 1000),
      request: { model: "example", messages: [] },
      response: {
        id: "example",
        object: "chat.completion",
        created: 0,
        model: "example",
        choices: [],
      },
    });
    if (index < 5) expected.push(row.id);
  }
  await drainBackgroundWork();
  await AgentModel.delete(deleted.id);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await InteractionModel.getSessionsCursor(
      { limit: 2, cursor },
      undefined,
      undefined,
      { organizationId: org.id, userId: user.id },
    );
    seen.push(...result.data.map((row) => row.interactionId as string));
    if (!result.pagination.hasNext) break;
    expect(result.pagination.nextCursor).toBeTruthy();
    cursor = result.pagination.nextCursor ?? undefined;
  }
  expect(seen).toEqual(expected);
});

test("a newer foreign-owner sibling still prevents an older local row from becoming the session head", async ({
  makeOrganization,
  makeAgent,
  makeInteraction,
}) => {
  const org = await makeOrganization();
  const other = await makeOrganization();
  const localAgent = await makeAgent({ organizationId: org.id });
  const foreignAgent = await makeAgent({ organizationId: other.id });
  const now = Date.now();
  await makeInteraction(localAgent.id, {
    sessionId: "mixed-session",
    createdAt: new Date(now - 1000),
  });
  await makeInteraction(foreignAgent.id, {
    sessionId: "mixed-session",
    createdAt: new Date(now),
  });
  const visible = await makeInteraction(localAgent.id, {
    createdAt: new Date(now - 2000),
  });
  const result = await InteractionModel.getSessionsCursor(
    { limit: 10 },
    undefined,
    undefined,
    { organizationId: org.id },
  );
  expect(result.data.map((row) => row.interactionId)).toEqual([visible.id]);
  expect(result.pagination.hasNext).toBe(false);
});

describe("stored session heads", () => {
  test("the stored-head page matches the interactions scan, page for page, and a cursor from either continues on the other", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    const other = await makeUser();
    const now = Date.now();
    // Interleaved sessions, sessionless rows and two users, so a head is
    // often several rows below the next one.
    for (let i = 0; i < 24; i++) {
      await makeInteraction(agent.id, {
        sessionId: i % 4 === 3 ? undefined : `session-${i % 5}`,
        userId: i % 3 === 0 ? other.id : user.id,
        createdAt: new Date(now - i * 1000),
      });
    }
    const walk = async (filters: { userId?: string }, flip: boolean) => {
      const keys: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        // Alternate readers between pages when flipping: the marker row
        // sends the read to the interactions scan.
        await setBackfillPending(flip && page % 2 === 1);
        const result = await InteractionModel.getSessionsCursor(
          { limit: 2, cursor },
          undefined,
          undefined,
          { organizationId: org.id, ...filters },
        );
        keys.push(
          ...result.data.map((row) => `${row.sessionId ?? row.interactionId}`),
        );
        if (!result.pagination.nextCursor) break;
        cursor = result.pagination.nextCursor;
      }
      return keys;
    };
    for (const filters of [{}, { userId: user.id }]) {
      await setBackfillPending(true);
      const scanned = await walk(filters, false);
      await setBackfillPending(false);
      const stored = await walk(filters, false);
      const mixed = await walk(filters, true);
      expect(stored).toEqual(scanned);
      expect(mixed).toEqual(scanned);
      expect(new Set(stored).size).toBe(stored.length);
    }
  });

  test("an older row arriving after a newer one does not move the head back", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent();
    const now = Date.now();
    const newer = await makeInteraction(agent.id, {
      sessionId: "late-writer",
      createdAt: new Date(now),
    });
    // A second writer whose row is older commits after the newer one.
    await makeInteraction(agent.id, {
      sessionId: "late-writer",
      createdAt: new Date(now - 5000),
    });
    expect(await headOf("late-writer")).toBe(newer.id);
  });

  test("two writers inserting into one session at once keep the newest head", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const now = Date.now();
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: uuidv7(),
      createdAt: new Date(now - ((i * 7) % 20) * 1000),
    }));
    await Promise.all(
      rows.map((row) =>
        db.insert(schema.interactionsTable).values({
          ...row,
          profileId: agent.id,
          sessionId: "racing",
          type: "openai:chatCompletions",
          request: { model: "example", messages: [] },
          response: {
            id: "example",
            object: "chat.completion",
            created: 0,
            model: "example",
            choices: [],
          },
        }),
      ),
    );
    const newest = [...rows].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    )[0];
    expect(await headOf("racing")).toBe(newest.id);
  });

  test("retention moves a session's head to its newest surviving row and drops emptied sessions", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent();
    const day = 86_400_000;
    const now = Date.now();
    const survivor = await makeInteraction(agent.id, {
      sessionId: "partly-expired",
      createdAt: new Date(now - 10 * day),
    });
    await makeInteraction(agent.id, {
      sessionId: "partly-expired",
      createdAt: new Date(now - 40 * day),
    });
    // Remove the head itself, as a deletion of the newest row would.
    const head = await makeInteraction(agent.id, {
      sessionId: "partly-expired",
      createdAt: new Date(now - 5 * day),
    });
    await makeInteraction(agent.id, {
      sessionId: "expired",
      createdAt: new Date(now - 40 * day),
    });
    await drainBackgroundWork();

    await db
      .delete(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, head.id));
    expect(await headOf("partly-expired")).toBe(survivor.id);

    await InteractionModel.deleteExpired({ retentionDays: 30 });
    expect(await headOf("partly-expired")).toBe(survivor.id);
    expect(await headOf("expired")).toBeUndefined();
  });

  test("the backfill folds existing history in batches, resumes after an interruption, and is idempotent", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent();
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      await makeInteraction(agent.id, {
        sessionId: i % 3 === 0 ? undefined : `history-${i % 2}`,
        createdAt: new Date(now - i * 1000),
      });
    }
    const expected = await storedHeads();
    // An upgrade: history exists, the head table does not cover it yet.
    await db.delete(schema.interactionSessionHeadsTable);
    await setBackfillPending(true);

    expect(
      await InteractionSessionHeadModel.backfill({
        batchSize: 2,
        maxBatches: 2,
      }),
    ).toBe("partial");
    expect(await InteractionSessionHeadModel.isComplete()).toBe(false);
    expect(await InteractionSessionHeadModel.backfill({ batchSize: 2 })).toBe(
      "complete",
    );
    expect(await InteractionSessionHeadModel.isComplete()).toBe(true);
    expect(await storedHeads()).toEqual(expected);

    expect(await InteractionSessionHeadModel.backfill({ batchSize: 2 })).toBe(
      "complete",
    );
    expect(await storedHeads()).toEqual(expected);
  });

  test("a page costs the same statements wherever its cursor points", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      await makeInteraction(agent.id, {
        sessionId: `budget-${i % 10}`,
        createdAt: new Date(now - i * 1000),
      });
    }
    await drainBackgroundWork();
    const page = (cursor?: string) =>
      recordQueries(() =>
        InteractionModel.getSessionsCursor(
          { limit: 3, cursor },
          undefined,
          undefined,
          { organizationId: org.id },
        ),
      );
    await page(); // learns that the head table is complete
    const first = await page();
    const deep = await page(
      (
        await InteractionModel.getSessionsCursor(
          { limit: 6 },
          undefined,
          undefined,
          {
            organizationId: org.id,
          },
        )
      ).pagination.nextCursor ?? undefined,
    );
    // Heads, the page aggregate, and the tip window — nothing per row.
    expect(first.statements).toHaveLength(3);
    expect(deep.statements).toHaveLength(3);
    expect(deep.result.data).toHaveLength(3);
    // Neither statement scans `interactions` for a newer sibling.
    expect(
      [...first.statements, ...deep.statements].some((s) =>
        /NOT EXISTS/i.test(s),
      ),
    ).toBe(false);
  });

  test("a chat session still carries its conversation title, and a non-uuid session id does not fail the page", async ({
    makeOrganization,
    makeAgent,
    makeConversation,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      title: "Quarterly numbers",
    });
    const now = Date.now();
    await makeInteraction(agent.id, {
      sessionId: conversation.id,
      createdAt: new Date(now),
    });
    await makeInteraction(agent.id, {
      sessionId: "not-a-uuid",
      createdAt: new Date(now - 1000),
    });
    await makeInteraction(agent.id, {
      sessionId: conversation.id.toUpperCase(),
      createdAt: new Date(now - 2000),
    });
    const result = await InteractionModel.getSessionsCursor(
      { limit: 10 },
      undefined,
      undefined,
      { organizationId: org.id },
    );
    expect(
      result.data.map((row) => [row.sessionId, row.conversationTitle]),
    ).toEqual([
      [conversation.id, "Quarterly numbers"],
      ["not-a-uuid", null],
      // Only the canonical lowercase id names the conversation.
      [conversation.id.toUpperCase(), null],
    ]);
  });
});

// ============================================================
// Helpers
// ============================================================

async function setBackfillPending(pending: boolean) {
  clearRegisteredProcessLocalCaches();
  if (pending) {
    await db
      .insert(schema.interactionSessionHeadsBackfillTable)
      .values({ id: 1 })
      .onConflictDoNothing();
  } else {
    await db.delete(schema.interactionSessionHeadsBackfillTable);
  }
}

async function headOf(sessionKey: string) {
  const [head] = await db
    .select({ id: schema.interactionSessionHeadsTable.lastInteractionId })
    .from(schema.interactionSessionHeadsTable)
    .where(eq(schema.interactionSessionHeadsTable.sessionKey, sessionKey));
  return head?.id;
}

async function storedHeads() {
  return db
    .select()
    .from(schema.interactionSessionHeadsTable)
    .orderBy(
      schema.interactionSessionHeadsTable.sessionless,
      schema.interactionSessionHeadsTable.sessionKey,
    );
}
