import { BM25_B_DEFAULT, BM25_K1_DEFAULT } from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { AclEntry, InsertKbDocument } from "@/types";
import KbChunkModel from "./kb-chunk";
import KbDocumentModel from "./kb-document";

function createDocumentData(
  connectorId: string,
  organizationId: string,
  overrides: Partial<InsertKbDocument> = {},
): InsertKbDocument {
  const id = crypto.randomUUID().substring(0, 8);
  return {
    connectorId,
    organizationId,
    title: `Test Document ${id}`,
    content: `Content for document ${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

/**
 * The behaviour BM25 exists to provide, stated as tests: a focused chunk beats
 * a longer one that merely repeats the query terms, and the ranker degrades to
 * `ts_rank` rather than going blind when its corpus statistics are missing.
 *
 * The padded chunk is deliberately built to WIN under `ts_rank`, which has no
 * document-length normalization and no term-frequency saturation. If a change
 * makes these tests pass under both rankers, the fixture has stopped testing
 * anything.
 */
describe("KbChunkModel BM25 ranking", () => {
  const ACL: AclEntry[] = ["org:*"];
  // Lucene's constants, the deployment default; these tests are about how
  // BM25 orders a corpus, not about tuning.
  const LUCENE_DEFAULTS = { k1: BM25_K1_DEFAULT, b: BM25_B_DEFAULT };

  async function seedCorpus(fixtures: {
    makeOrganization: () => Promise<{ id: string }>;
    makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
    makeKnowledgeBaseConnector: (
      kbId: string,
      orgId: string,
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string }>;
  }) {
    const org = await fixtures.makeOrganization();
    const kb = await fixtures.makeKnowledgeBase(org.id);
    const connector = await fixtures.makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
    });
    const doc = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, { title: "Runbook" }),
    );

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "kubernetes ingress timeout misconfiguration root cause",
        chunkIndex: 0,
        acl: ACL,
      },
      {
        // Same terms, three times each, then padding. Longer and repetitive:
        // exactly the shape ts_rank over-rewards.
        documentId: doc.id,
        content: `kubernetes kubernetes kubernetes ingress ingress ingress timeout timeout timeout ${"filler padding boilerplate noise unrelated ".repeat(
          30,
        )}`,
        chunkIndex: 1,
        acl: ACL,
      },
    ]);

    return { connectorId: connector.id };
  }

  test("ranks a focused chunk above a longer chunk that repeats the query terms", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { connectorId } = await seedCorpus({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });

    await KbChunkModel.refreshBm25Stats();

    const bm25 = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "kubernetes ingress timeout",
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 10,
    });

    expect(bm25).toHaveLength(2);
    expect(bm25[0]?.chunkIndex).toBe(0);

    // The same corpus and query under ts_rank (no BM25 constants — what the
    // query service passes while the statistics are missing) prefers the
    // padded chunk. This is the regression BM25 fixes, pinned so the fixture
    // cannot silently stop discriminating between the two rankers.
    const tsRank = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "kubernetes ingress timeout",
      userAcl: ACL,
      limit: 10,
    });
    expect(tsRank[0]?.chunkIndex).toBe(1);
  });

  test("scores rare terms above terms common to the whole corpus", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
    });
    const doc = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id),
    );

    // "deployment" is in every chunk and so carries almost no information;
    // "zookeeper" is in exactly one. IDF is the only thing that separates them.
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "deployment zookeeper quorum",
        chunkIndex: 0,
        acl: ACL,
      },
      {
        documentId: doc.id,
        content: "deployment rollout",
        chunkIndex: 1,
        acl: ACL,
      },
      {
        documentId: doc.id,
        content: "deployment scaling",
        chunkIndex: 2,
        acl: ACL,
      },
      {
        documentId: doc.id,
        content: "deployment probes",
        chunkIndex: 3,
        acl: ACL,
      },
    ]);

    await KbChunkModel.refreshBm25Stats();

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "deployment zookeeper",
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 10,
    });

    expect(results[0]?.chunkIndex).toBe(0);
  });

  test("reports statistics as unavailable until a refresh has run", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { connectorId } = await seedCorpus({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });

    expect(await KbChunkModel.hasBm25Stats(["english"], [connectorId])).toBe(
      false,
    );

    await KbChunkModel.refreshBm25Stats();

    expect(await KbChunkModel.hasBm25Stats(["english"], [connectorId])).toBe(
      true,
    );
  });

  test("returns numeric scores, not the strings a numeric sum decodes to", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { connectorId } = await seedCorpus({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });
    await KbChunkModel.refreshBm25Stats();

    const [bm25] = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "kubernetes ingress timeout",
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 1,
    });
    const [tsRank] = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "kubernetes ingress timeout",
      userAcl: ACL,
      limit: 1,
    });

    // Both lanes feed one fused result list, so both must speak the same type.
    expect(typeof bm25?.score).toBe("number");
    expect(typeof tsRank?.score).toBe("number");
    expect(Number.isFinite(bm25?.score)).toBe(true);
  });

  test("a language with nothing indexed does not block BM25", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { connectorId } = await seedCorpus({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });
    await KbChunkModel.refreshBm25Stats();

    // `ts_stat` only ever sees languages that have chunks, so a connector
    // created in a language nothing has been indexed in yet never gets
    // statistics. Blocking on it would disable BM25 permanently rather than
    // until the next refresh — the empty-connector trap.
    expect(
      await KbChunkModel.hasBm25Stats(["english", "german"], [connectorId]),
    ).toBe(true);
  });

  test("a language WITH indexed chunks and no statistics still blocks BM25", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      ftsLanguage: "german",
    });
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Handbuch",
      content: "Wareneingang",
      contentHash: "h-de-block",
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Die Wareneingangsprüfung erfolgt stichprobenartig",
        chunkIndex: 0,
        acl: ACL,
        ftsLanguage: "german",
      },
    ]);

    expect(await KbChunkModel.hasBm25Stats(["german"], [connector.id])).toBe(
      false,
    );
    await KbChunkModel.refreshBm25Stats();
    expect(await KbChunkModel.hasBm25Stats(["german"], [connector.id])).toBe(
      true,
    );
  });

  test("rebuilding repeatedly replaces the statistics rather than accumulating them", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { connectorId } = await seedCorpus({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    });

    const first = await KbChunkModel.refreshBm25Stats();
    const second = await KbChunkModel.refreshBm25Stats();

    // DELETE + INSERT, not INSERT: a second pass over an unchanged corpus must
    // land on exactly the same counts instead of colliding on the
    // (fts_language, term) primary key or double-counting document frequency.
    // (True concurrency is not exercised here — the test driver serializes
    // everything onto one connection; the advisory lock is what covers that in
    // production.)
    expect(second).toEqual(first);
    // The effect, not the reported counts: `rowCount` for INSERT ... SELECT is
    // driver-dependent (the in-process test driver reports 0 where PostgreSQL
    // reports the rows), so the returned tallies are only good for logging.
    expect(await KbChunkModel.hasBm25Stats(["english"], [connectorId])).toBe(
      true,
    );

    const [top] = await KbChunkModel.fullTextSearch({
      connectorIds: [connectorId],
      queryText: "kubernetes ingress timeout",
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 1,
    });
    expect(top?.chunkIndex).toBe(0);
  });

  test("finds a term first indexed after the last statistics rebuild", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const seededDoc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Runbook",
      content: "gateway",
      contentHash: "h-novel-seed",
    });
    await KbChunkModel.insertMany([
      {
        documentId: seededDoc.id,
        content: "gateway watchdog restart procedure",
        chunkIndex: 0,
        acl: ACL,
      },
    ]);
    await KbChunkModel.refreshBm25Stats();

    // Ingested AFTER the rebuild, carrying an identifier that appears in no
    // counted document — so it has no kb_bm25_term_stats row. An inner join
    // against the statistics would drop this chunk and the keyword lane would
    // return nothing for a search that quotes the identifier exactly.
    const freshDoc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Incident",
      content: "zt9quartzline",
      contentHash: "h-novel-fresh",
    });
    await KbChunkModel.insertMany([
      {
        documentId: freshDoc.id,
        content: "incident zt9quartzline traced to the gateway watchdog",
        chunkIndex: 0,
        acl: ACL,
      },
    ]);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "zt9quartzline",
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("zt9quartzline");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("still ranks chunks left in a configuration the connector no longer uses", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      ftsLanguage: "english",
    });
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Runbook",
      content: "gateway",
      contentHash: "h-drift",
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "gateway watchdog restart procedure",
        chunkIndex: 0,
        acl: ACL,
        ftsLanguage: "english",
      },
    ]);
    await KbChunkModel.refreshBm25Stats();

    // Switching the connector's language does not re-index what is already
    // stored: the chunk keeps its English lexemes. Parsing the query only in
    // the connector's new language would leave it with nothing to match.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ ftsLanguage: "german" })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "gateway watchdog",
      languages: ["german"],
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("still returns chunks stored under a configuration with no statistics", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      ftsLanguage: "german",
    });
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Handbuch",
      content: "Wareneingang",
      contentHash: "h-orphan",
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Die Wareneingangsprüfung erfolgt stichprobenartig",
        chunkIndex: 0,
        acl: ACL,
        ftsLanguage: "german",
      },
      // A second configuration keeps the statistics table populated, as any
      // real deployment would be.
      {
        documentId: doc.id,
        content: "gateway watchdog restart procedure",
        chunkIndex: 1,
        acl: ACL,
        ftsLanguage: "english",
      },
    ]);
    await KbChunkModel.refreshBm25Stats();

    // The connector moves to English; its German chunks stay German. Then the
    // German statistics go away (only that language's documents were removed
    // elsewhere, say). An inner join on the corpus statistics would drop this
    // chunk silently — returning FEWER results than the fallback ranker would,
    // which is the one thing the fallback exists to prevent.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ ftsLanguage: "english" })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    await db.execute(
      sql`DELETE FROM kb_bm25_corpus_stats WHERE fts_language = 'german'`,
    );

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "Wareneingangsprüfung stichprobenartig",
      languages: ["german"],
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(Number.isFinite(results[0]?.score)).toBe(true);
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("does not score the OR-fallback's own operator as a query term", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    // `simple` keeps "or" as a lexeme where English drops it as a stopword.
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      ftsLanguage: "simple",
    });
    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Runbook",
      content: "or",
      contentHash: "h-or-fallback",
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        // Holds the operator token and ONE of the query terms, so it only
        // survives the OR fallback — and must not be scored for "or".
        content: "the failover collector or the standby relay",
        chunkIndex: 0,
        acl: ACL,
        ftsLanguage: "simple",
      },
      {
        documentId: doc.id,
        content: "the failover collector runs nightly",
        chunkIndex: 1,
        acl: ACL,
        ftsLanguage: "simple",
      },
    ]);
    await KbChunkModel.refreshBm25Stats();

    // No chunk holds every term, so this takes the OR fallback, whose tsquery
    // text is "failover OR zzzabsent". Scoring that text instead of the
    // original would hand chunk 0 a rare, high-IDF hit on "or" and float it
    // above the chunk that matches the real query term just as well.
    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "failover zzzabsent",
      languages: ["simple"],
      bm25: LUCENE_DEFAULTS,
      userAcl: ACL,
      limit: 10,
    });

    // Both chunks match "failover" once. Scored honestly, the shorter one wins
    // on length normalization. Had "or" been scored, chunk 0 would have picked
    // up a second, rare, high-IDF hit and taken the top spot instead.
    expect(results).toHaveLength(2);
    expect(results[0]?.chunkIndex).toBe(1);
  });

  test("orders equally-scored chunks deterministically", async ({
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
      contentHash: "h-tiebreak",
    });
    await KbChunkModel.insertMany(
      Array.from({ length: 6 }, (_, index) => ({
        documentId: doc.id,
        content: "gateway watchdog restart procedure",
        chunkIndex: index,
        acl: ACL,
      })),
    );
    await KbChunkModel.refreshBm25Stats();

    // Identical text means identical scores, so only the id tiebreak decides
    // the order — without it the same query can return a different page of
    // results run to run, and the candidate window can admit a different set.
    const run = () =>
      KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "gateway watchdog",
        bm25: LUCENE_DEFAULTS,
        userAcl: ACL,
        limit: 3,
      });
    const first = await run();
    const second = await run();

    expect(first).toHaveLength(3);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect([...first.map((r) => r.id)].sort()).toEqual(first.map((r) => r.id));
  });

  test("keeps ACL filtering when ranking with BM25", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
    });
    const doc = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id),
    );

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "quarterly revenue forecast",
        chunkIndex: 0,
        acl: ["team:finance"],
      },
      {
        documentId: doc.id,
        content: "quarterly revenue summary",
        chunkIndex: 1,
        acl: ["org:*"],
      },
    ]);

    await KbChunkModel.refreshBm25Stats();

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "quarterly revenue",
      bm25: LUCENE_DEFAULTS,
      userAcl: ["org:*"],
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkIndex).toBe(1);
  });
});
