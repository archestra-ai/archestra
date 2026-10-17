import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { handleInteractionUserActivityRebuild } from "@/task-queue/handlers/interaction-user-activity-rebuild-handler";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { recordQueries } from "@/test/query-counter";
import type { InteractionResponse } from "@/types";
import InteractionModel from "./interaction";
import InteractionUserActivityModel from "./interaction-user-activity";

setupTestCacheManager();

describe("transactional interaction user activity", () => {
  test("incomplete backfill falls back; resumable batches preserve exact counts, ties and historical users", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const quiet = await makeUser({ name: "Alpha" });
    const busy = await makeUser({ name: "Zulu" });
    await insert({ userId: quiet.id, profileId: agent.id });
    await insert({ userId: busy.id, profileId: agent.id });
    await insert({ userId: busy.id, profileId: agent.id });
    const expected = await InteractionModel.getUniqueUserIds({
      organizationId: org.id,
      limit: 100,
    });
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toEqual(expected);
    expect((await InteractionUserActivityModel.state()).ready).toBe(false);
    await InteractionUserActivityModel.rebuildBatch({ batchSize: 1 });
    await rebuild();
    expect(await ranked(org.id)).toEqual(expected);
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toEqual(expected);
    await rebuild();
    expect(await ranked(org.id)).toEqual(expected);
    await db
      .update(schema.usersTable)
      .set({ name: "Changed live" })
      .where(eq(schema.usersTable.id, busy.id));
    expect((await ranked(org.id))[0].name).toBe("Changed live");
    expect(await db.select().from(schema.membersTable)).toHaveLength(0);
  });

  test("the actual append funnel atomically updates a ready summary and null users do not count", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await rebuild();
    await InteractionModel.create({
      profileId: agent.id,
      userId: user.id,
      ...payload(),
    });
    await insert({ profileId: agent.id, userId: null });
    expect(await ranked(org.id)).toEqual(
      await InteractionModel.getUniqueUserIds({
        organizationId: org.id,
        limit: 100,
      }),
    );
    expect(
      (await db.select().from(schema.interactionUserActivityTable))[0]
        .activityCount,
    ).toBe(1);
  });

  test("ready cold-cache defaults read no interaction history while search and IDs retain exact scope", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreign = await makeAgent({ organizationId: other.id });
    const quiet = await makeUser({ name: "Alpha" });
    const busy = await makeUser({ name: "Zulu" });
    const excluded = await makeUser({ name: "Foreign" });
    await insert({ userId: quiet.id, profileId: agent.id });
    await insert({ userId: busy.id, profileId: agent.id });
    await insert({ userId: busy.id, profileId: agent.id });
    await insert({ userId: excluded.id, profileId: foreign.id });
    await rebuild();
    const expected = [
      { id: busy.id, name: busy.name },
      { id: quiet.id, name: quiet.name },
    ];
    const cold = await recordQueries(() =>
      InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    );
    expect(cold.result).toEqual(expected);
    expect(
      cold.statements.some((statement) =>
        /\b(?:from|join)\s+"?interactions"?\b/i.test(statement),
      ),
    ).toBe(false);
    const warm = await recordQueries(() =>
      InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 1,
      }),
    );
    expect(warm.result).toEqual(expected.slice(0, 1));
    expect(
      warm.statements.some((statement) =>
        /\b(?:from|join)\s+"?interaction_user_activity"?\b/i.test(statement),
      ),
    ).toBe(false);
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        search: "Alpha",
        limit: 100,
      }),
    ).toEqual(expected.slice(1));
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        ids: [quiet.id, excluded.id],
        limit: 100,
      }),
    ).toEqual(expected.slice(1));
  });

  test("unattributed appends retain the direct insert budget and later attribution maintains counts", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await rebuild();
    for (const userId of [null, undefined]) {
      const measured = await recordQueries(() =>
        InteractionModel.create({ profileId: agent.id, userId, ...payload() }),
      );
      expect(measured.result.userId).toBeNull();
      expect(
        measured.statements.some((statement) =>
          /interaction_user_activity|\bbegin\b|\bcommit\b/i.test(statement),
        ),
      ).toBe(false);
      expect(
        measured.statements.filter(
          (statement) =>
            !(
              /^update "agents" set /i.test(statement) &&
              statement.includes('"last_used_at"')
            ),
        ),
      ).toHaveLength(2);
      await InteractionUserActivityModel.updateAttribution({
        id: measured.result.id,
        attribution: { userId: user.id },
      });
    }
    expect(await ranked(org.id)).toEqual([{ id: user.id, name: user.name }]);
    expect(
      (await db.select().from(schema.interactionUserActivityTable))[0]
        .activityCount,
    ).toBe(2);
  });

  test("stable interaction IDs make an append replay idempotent after a committed result is lost", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await rebuild();
    const data = {
      id: randomUUID(),
      userId: user.id,
      profileId: agent.id,
      ...payload(),
    };
    const first = await InteractionModel.create(data);
    expect((await InteractionModel.create(data)).id).toBe(first.id);
    expect(await db.select().from(schema.interactionsTable)).toHaveLength(1);
    expect(
      (await db.select().from(schema.interactionUserActivityTable))[0]
        .activityCount,
    ).toBe(1);
  });

  test("automatic rebuild is gated during mixed-version rollout and resumes after activation", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await insert({ userId: user.id, profileId: agent.id });
    expect((await InteractionUserActivityModel.rebuildBatch()).ready).toBe(
      false,
    );
    expect((await InteractionUserActivityModel.state()).enabled).toBe(false);
    expect(
      await db.select().from(schema.interactionUserActivityDeltasTable),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.interactionUserActivityUsersTable),
    ).toHaveLength(0);
    await handleInteractionUserActivityRebuild({}, { taskId: randomUUID() });
    expect((await InteractionUserActivityModel.state()).ready).toBe(false);
    await InteractionUserActivityModel.setEnabled(true);
    await handleInteractionUserActivityRebuild({}, { taskId: randomUUID() });
    expect((await InteractionUserActivityModel.state()).ready).toBe(true);
    await rebuild();
    await InteractionUserActivityModel.setEnabled(false);
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toEqual([{ id: user.id, name: user.name }]);
    await rebuild();
    expect(await ranked(org.id)).toHaveLength(1);
  });

  test("connector reparenting and agent deletion invalidate exact fallback; rollback preserves readiness", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    const knowledge = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(knowledge.id, org.id);
    await insert({
      userId: user.id,
      profileId: agent.id,
      connectorId: connector.id,
    });
    await rebuild();
    const previous = await InteractionUserActivityModel.state();
    await expect(
      db.transaction(async (tx) => {
        await tx
          .delete(schema.agentsTable)
          .where(eq(schema.agentsTable.id, agent.id));
        throw new Error("lifecycle rollback");
      }),
    ).rejects.toThrow("lifecycle rollback");
    expect(await InteractionUserActivityModel.state()).toEqual(previous);
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ organizationId: other.id })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    expect((await InteractionUserActivityModel.state()).ready).toBe(false);
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toEqual([]);
    await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    await rebuild();
    expect(await ranked(org.id)).toEqual([]);
    expect(await ranked(other.id)).toEqual([{ id: user.id, name: user.name }]);
    await db
      .delete(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    await rebuild();
    expect(await ranked(other.id)).toEqual([]);
  });

  test("failed append rolls back log, delta ledger and summary together", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await rebuild();
    await expect(
      InteractionUserActivityModel.mutate({
        userIds: [user.id],
        run: async (tx) => {
          await tx
            .insert(schema.interactionsTable)
            .values({ userId: user.id, profileId: agent.id, ...payload() });
          throw new Error("rollback fixture");
        },
      }),
    ).rejects.toThrow("rollback fixture");
    expect(await db.select().from(schema.interactionsTable)).toHaveLength(0);
    expect(
      await db.select().from(schema.interactionUserActivityDeltasTable),
    ).toHaveLength(0);
    expect(await ranked(org.id)).toEqual([]);
  });

  test("attribution changes move counts and remove zero rows atomically, including null attribution", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const foreign = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const other = await makeAgent({ organizationId: foreign.id });
    const first = await makeUser();
    const second = await makeUser();
    const row = await insert({ userId: first.id, profileId: agent.id });
    await rebuild();
    await InteractionUserActivityModel.updateAttribution({
      id: row.id,
      attribution: { userId: second.id, profileId: other.id },
    });
    expect(await ranked(org.id)).toEqual([]);
    expect(await ranked(foreign.id)).toEqual([
      { id: second.id, name: second.name },
    ]);
    await InteractionUserActivityModel.updateAttribution({
      id: row.id,
      attribution: { userId: null },
    });
    expect(
      await db.select().from(schema.interactionUserActivityTable),
    ).toHaveLength(0);
    await InteractionUserActivityModel.updateAttribution({
      id: row.id,
      attribution: { userId: first.id },
    });
    expect(await ranked(foreign.id)).toEqual([
      { id: first.id, name: first.name },
    ]);
  });

  test("retention decrements batches to zero without changing surviving counts", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await insert({
      userId: user.id,
      profileId: agent.id,
      createdAt: new Date("2000-01-01"),
    });
    await insert({ userId: user.id, profileId: agent.id });
    await rebuild();
    expect(
      await InteractionModel.deleteExpired({ retentionDays: 1, batchSize: 1 }),
    ).toBe(1);
    expect(
      (await db.select().from(schema.interactionUserActivityTable))[0]
        .activityCount,
    ).toBe(1);
    await InteractionUserActivityModel.updateAttribution({
      id: (await db.select().from(schema.interactionsTable))[0].id,
      attribution: { userId: null },
    });
    expect(await ranked(org.id)).toEqual([]);
  });

  test("user deletion cascades counters and ledger, nulls logs and keeps remaining summary ready", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await insert({ userId: user.id, profileId: agent.id });
    await rebuild();
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, user.id));
    expect((await InteractionUserActivityModel.state()).ready).toBe(true);
    expect(await ranked(org.id)).toEqual([]);
    expect(
      (await db.select().from(schema.interactionsTable))[0].userId,
    ).toBeNull();
    expect(
      await db.select().from(schema.interactionUserActivityDeltasTable),
    ).toHaveLength(0);
  });

  test("owner reparenting invalidates cached counts and fallback never enumerates foreign users", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await insert({ userId: user.id, profileId: agent.id });
    await rebuild();
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toHaveLength(1);
    await db
      .update(schema.agentsTable)
      .set({ organizationId: other.id })
      .where(eq(schema.agentsTable.id, agent.id));
    expect((await InteractionUserActivityModel.state()).ready).toBe(false);
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toEqual([]);
    await rebuild();
    expect(await ranked(other.id)).toEqual([{ id: user.id, name: user.name }]);
  });

  test("owner matrix uses every nonnull owner, not membership; a missing owner created later invalidates", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeApp,
    makeKnowledgeBaseConnector,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const foreign = await makeAgent({ organizationId: other.id });
    const app = await makeApp({ organizationId: org.id });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
    );
    const missingId = randomUUID();
    const owners = [
      { profileId: agent.id },
      { appId: app.id },
      { connectorId: connector.id },
      { profileId: agent.id, appId: app.id, connectorId: connector.id },
      { profileId: foreign.id, appId: app.id },
      { appId: missingId },
      { profileId: agent.id, appId: missingId },
      {},
    ];
    for (const owner of owners) {
      const user = await makeUser();
      await insert({ ...owner, userId: user.id });
    }
    await rebuild();
    expect(await ranked(org.id)).toEqual(
      await InteractionModel.getUniqueUserIds({
        organizationId: org.id,
        limit: 100,
      }),
    );
    expect(await ranked(org.id)).toHaveLength(4);
    await makeApp({ organizationId: org.id });
    expect((await InteractionUserActivityModel.state()).ready).toBe(true);
    await db.insert(schema.appsTable).values({
      id: missingId,
      organizationId: org.id,
      name: "Recovered owner",
      latestVersion: 1,
    });
    expect((await InteractionUserActivityModel.state()).ready).toBe(false);
    await rebuild();
    expect(await ranked(org.id)).toHaveLength(6);
    await db.delete(schema.appsTable).where(eq(schema.appsTable.id, app.id));
    expect((await InteractionUserActivityModel.state()).ready).toBe(false);
    await rebuild();
    expect(await ranked(org.id)).toEqual(
      await InteractionModel.getUniqueUserIds({
        organizationId: org.id,
        limit: 100,
      }),
    );
  });

  test("manual recovery discards old generation checkpoints, remains exact and is idempotent", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await insert({ userId: user.id, profileId: agent.id });
    await rebuild();
    await db.execute(
      sql`UPDATE interaction_user_activity SET activity_count=99`,
    );
    await InteractionUserActivityModel.invalidate();
    expect(
      await InteractionModel.getUserFilterOptions({
        organizationId: org.id,
        limit: 100,
      }),
    ).toEqual([{ id: user.id, name: user.name }]);
    await rebuild();
    expect(
      (await db.select().from(schema.interactionUserActivityTable))[0]
        .activityCount,
    ).toBe(1);
    await rebuild();
    expect(
      (await db.select().from(schema.interactionUserActivityTable))[0]
        .activityCount,
    ).toBe(1);
  });

  test("an empty cold generation becomes complete and remains ready for newly created users", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    await rebuild();
    expect(await ranked(org.id)).toEqual([]);
    const user = await makeUser();
    await insert({ profileId: agent.id, userId: user.id });
    expect(await ranked(org.id)).toEqual([{ id: user.id, name: user.name }]);
  });
});

async function insert(
  data: Omit<
    typeof schema.interactionsTable.$inferInsert,
    "request" | "response" | "type"
  >,
) {
  return InteractionUserActivityModel.mutate({
    userIds: [data.userId],
    run: async (tx) => {
      const [row] = await tx
        .insert(schema.interactionsTable)
        .values({ ...data, ...payload() })
        .returning();
      return { result: row, changes: [{ ...row, delta: 1 }] };
    },
  });
}

async function rebuild() {
  await InteractionUserActivityModel.setEnabled(true);
  for (let batch = 0; batch < 100; batch++) {
    if (
      (await InteractionUserActivityModel.rebuildBatch({ batchSize: 3 })).ready
    )
      return;
  }
  throw new Error("Fixture rebuild did not finish");
}

async function ranked(organizationId: string) {
  const state = await InteractionUserActivityModel.state();
  return InteractionUserActivityModel.mostActive({
    organizationId,
    limit: 100,
    generation: state.generation,
  });
}

function payload() {
  return {
    type: "openai:chatCompletions" as const,
    request: { model: "example", messages: [] },
    response: {
      id: "example",
      object: "chat.completion",
      created: 0,
      model: "example",
      choices: [],
    } as InteractionResponse,
  };
}
