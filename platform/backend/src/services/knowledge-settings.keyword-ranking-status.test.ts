import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { KbChunkModel, KbDocumentModel, TaskModel } from "@/models";
import { describe, expect, test } from "@/test";
import { knowledgeSettingsService } from "./knowledge-settings";

const REFRESH_TASK = "kb_bm25_stats_refresh" as const;

describe("getKeywordRankingStatus", () => {
  async function seedConnectorWithChunk(
    fixtures: {
      makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
      makeKnowledgeBaseConnector: (
        kbId: string,
        orgId: string,
        overrides?: { ftsLanguage?: "english" | "german" },
      ) => Promise<{ id: string }>;
    },
    organizationId: string,
    language: "english" | "german",
    withChunk = true,
  ) {
    const kb = await fixtures.makeKnowledgeBase(organizationId);
    const connector = await fixtures.makeKnowledgeBaseConnector(
      kb.id,
      organizationId,
      { ftsLanguage: language },
    );
    if (!withChunk) return connector;
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId,
      title: "Runbook",
      content: "ingress timeout",
      contentHash: `h-${connector.id}`,
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "kubernetes ingress timeout",
        chunkIndex: 0,
        acl: ["org:*"],
        ftsLanguage: language,
      },
    ]);
    return connector;
  }

  test("reports no documents for an organization with nothing indexed", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    expect(
      await knowledgeSettingsService.getKeywordRankingStatus(org.id),
    ).toEqual({
      status: "no_documents",
      lastRefreshedAt: null,
      nextRefreshAt: null,
      refreshing: false,
      lastRefreshFailed: false,
    });

    // A connector that has not indexed anything yet changes nothing: there
    // is no chunk for the statistics to cover.
    await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "english",
      false,
    );
    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("no_documents");
  });

  test("is pending while an indexed language has no statistics, ready once it does", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "english",
    );
    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("pending");

    await KbChunkModel.refreshBm25Stats();
    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("ready");

    // A language first indexed since the last rebuild drops back to pending
    // until the next one — exactly the window in which the query service ranks
    // that language with ts_rank. A connector that is empty in yet another
    // language is not counted: nothing to rank there.
    await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "german",
    );
    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("pending");
    await KbChunkModel.refreshBm25Stats();
    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("ready");
  });

  test("a connector in a language with nothing indexed does not hold the status at pending", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "english",
    );
    await KbChunkModel.refreshBm25Stats();
    // Mirrors KbChunkModel.hasBm25Stats: a language nothing is indexed in
    // never gets statistics, so reporting it as pending would leave the page
    // claiming "building" forever while searches actually rank with BM25.
    await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "german",
      false,
    );

    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("ready");
  });

  test("keys chunk presence on the chunk's own language, not the connector's current one", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "english",
    );
    await KbChunkModel.refreshBm25Stats();

    // Switching a connector's language leaves its existing chunks in the old
    // one. The new language has no chunks yet, so it must not read as pending.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ ftsLanguage: "german" })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));

    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("ready");
  });

  test("reports nothing searchable once every connector is in the trash", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnectorWithChunk(
      { makeKnowledgeBase, makeKnowledgeBaseConnector },
      org.id,
      "english",
    );
    await KbChunkModel.refreshBm25Stats();
    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("ready");

    // Soft-deleting the connector leaves its documents indexed but takes them
    // out of every search, so claiming BM25 is ranking them would be a lie.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));

    expect(
      (await knowledgeSettingsService.getKeywordRankingStatus(org.id)).status,
    ).toBe("no_documents");
  });

  test("reads the refresh task's last success, next run, in-flight run and latest failure", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const succeededAt = new Date("2026-08-20T10:00:00.000Z");
    const failedAt = new Date("2026-08-20T11:00:00.000Z");
    const nextRunAt = new Date("2026-08-20T12:00:00.000Z");
    await TaskModel.create({
      taskType: REFRESH_TASK,
      payload: {},
      status: "completed",
      completedAt: succeededAt,
      periodic: true,
    });
    await TaskModel.create({
      taskType: REFRESH_TASK,
      payload: {},
      status: "dead",
      completedAt: failedAt,
      lastError: "relation kb_chunks does not exist",
      periodic: true,
    });
    await TaskModel.create({
      taskType: REFRESH_TASK,
      payload: {},
      status: "pending",
      scheduledFor: nextRunAt,
      periodic: true,
    });

    const status = await knowledgeSettingsService.getKeywordRankingStatus(
      org.id,
    );
    expect(status.lastRefreshedAt).toBe(succeededAt.toISOString());
    expect(status.nextRefreshAt).toBe(nextRunAt.toISOString());
    expect(status.refreshing).toBe(false);
    // The failure is newer than the success, so it is the latest attempt —
    // reported as a flag, never as the raw message: the rebuild spans every
    // organization, so its error can describe another tenant's corpus.
    expect(status.lastRefreshFailed).toBe(true);
    expect(JSON.stringify(status)).not.toContain("kb_chunks");

    // A later success clears it; a row in flight reports as refreshing.
    const laterSuccessAt = new Date("2026-08-20T11:30:00.000Z");
    await TaskModel.create({
      taskType: REFRESH_TASK,
      payload: {},
      status: "completed",
      completedAt: laterSuccessAt,
      periodic: true,
    });
    await TaskModel.create({
      taskType: REFRESH_TASK,
      payload: {},
      status: "processing",
      periodic: false,
    });
    const later = await knowledgeSettingsService.getKeywordRankingStatus(
      org.id,
    );
    expect(later.lastRefreshedAt).toBe(laterSuccessAt.toISOString());
    expect(later.lastRefreshFailed).toBe(false);
    expect(later.refreshing).toBe(true);
  });
});
