import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { handleKbBm25StatsRefresh } from "./kb-bm25-stats-refresh-handler";

describe("handleKbBm25StatsRefresh", () => {
  test("builds the statistics the ranker needs, from whatever is indexed", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Runbook",
      content: "gateway",
      contentHash: "h-handler",
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "gateway watchdog restart procedure",
        chunkIndex: 0,
        acl: ["org:*"],
      },
    ]);

    // Before the task runs, the ranker has nothing to score from and keyword
    // search falls back to ts_rank.
    expect(await KbChunkModel.hasBm25Stats(["english"], [connector.id])).toBe(
      false,
    );

    // The real rebuild — the handler is one call, so mocking it would leave
    // this test asserting only that a function calls a function.
    await handleKbBm25StatsRefresh();

    expect(await KbChunkModel.hasBm25Stats(["english"], [connector.id])).toBe(
      true,
    );
    const [top] = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "gateway watchdog",
      bm25: { k1: 1.2, b: 0.75 },
      userAcl: ["org:*"],
      limit: 1,
    });
    expect(top?.chunkIndex).toBe(0);
  });

  test("runs for every deployment, with no corpus to work from", async () => {
    // No documents anywhere: the task still has to complete rather than throw,
    // because it is seeded unconditionally at boot and a failure would take
    // the whole periodic chain down with it.
    await expect(handleKbBm25StatsRefresh()).resolves.toBeUndefined();
  });
});
