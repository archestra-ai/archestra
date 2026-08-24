import { describe, expect, test } from "@/test";
import type { InsertKbDocument } from "@/types";
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

describe("KbChunkModel", () => {
  describe("insertMany", () => {
    test("inserts multiple chunks for a document", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      const chunks = await KbChunkModel.insertMany([
        { documentId: doc.id, content: "Chunk 0 content", chunkIndex: 0 },
        { documentId: doc.id, content: "Chunk 1 content", chunkIndex: 1 },
        { documentId: doc.id, content: "Chunk 2 content", chunkIndex: 2 },
      ]);

      expect(chunks).toHaveLength(3);
      for (const chunk of chunks) {
        expect(chunk.id).toBeDefined();
        expect(chunk.documentId).toBe(doc.id);
        expect(chunk.createdAt).toBeInstanceOf(Date);
        expect(chunk.acl).toEqual([]);
      }
    });

    test("returns empty array when given empty input", async () => {
      const chunks = await KbChunkModel.insertMany([]);
      expect(chunks).toEqual([]);
    });

    test("inserts chunks with optional acl", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      const chunks = await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "Restricted chunk",
          chunkIndex: 0,
          acl: ["team-alpha", "team-beta"],
        },
      ]);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].acl).toEqual(["team-alpha", "team-beta"]);
    });
  });

  describe("findByDocument", () => {
    test("returns chunks ordered by chunkIndex", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      // Insert chunks in non-sequential order
      await KbChunkModel.insertMany([
        { documentId: doc.id, content: "Third chunk", chunkIndex: 2 },
        { documentId: doc.id, content: "First chunk", chunkIndex: 0 },
        { documentId: doc.id, content: "Second chunk", chunkIndex: 1 },
      ]);

      const chunks = await KbChunkModel.findByDocument(doc.id);

      expect(chunks).toHaveLength(3);
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[0].content).toBe("First chunk");
      expect(chunks[1].chunkIndex).toBe(1);
      expect(chunks[1].content).toBe("Second chunk");
      expect(chunks[2].chunkIndex).toBe(2);
      expect(chunks[2].content).toBe("Third chunk");
    });

    test("does not return chunks from other documents", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc1 = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );
      const doc2 = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        { documentId: doc1.id, content: "Doc1 chunk", chunkIndex: 0 },
        { documentId: doc2.id, content: "Doc2 chunk", chunkIndex: 0 },
      ]);

      const chunks = await KbChunkModel.findByDocument(doc1.id);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe("Doc1 chunk");
    });

    test("returns empty array when document has no chunks", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      const chunks = await KbChunkModel.findByDocument(doc.id);
      expect(chunks).toEqual([]);
    });
  });

  describe("deleteByDocument", () => {
    test("deletes all chunks for a document", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        { documentId: doc.id, content: "Chunk 0", chunkIndex: 0 },
        { documentId: doc.id, content: "Chunk 1", chunkIndex: 1 },
        { documentId: doc.id, content: "Chunk 2", chunkIndex: 2 },
      ]);

      await KbChunkModel.deleteByDocument(doc.id);

      // Verify chunks are actually gone (PGlite may not return accurate rowCount)
      const remaining = await KbChunkModel.findByDocument(doc.id);
      expect(remaining).toEqual([]);
    });

    test("does not delete chunks from other documents", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc1 = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );
      const doc2 = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        { documentId: doc1.id, content: "Doc1 chunk", chunkIndex: 0 },
        { documentId: doc2.id, content: "Doc2 chunk", chunkIndex: 0 },
      ]);

      await KbChunkModel.deleteByDocument(doc1.id);

      const doc2Chunks = await KbChunkModel.findByDocument(doc2.id);
      expect(doc2Chunks).toHaveLength(1);
    });

    test("does not error when document has no chunks", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      // Should not throw even when there are no chunks to delete
      await KbChunkModel.deleteByDocument(doc.id);

      const remaining = await KbChunkModel.findByDocument(doc.id);
      expect(remaining).toEqual([]);
    });
  });

  describe("countByDocument", () => {
    test("returns the count of chunks for a document", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        { documentId: doc.id, content: "Chunk 0", chunkIndex: 0 },
        { documentId: doc.id, content: "Chunk 1", chunkIndex: 1 },
      ]);

      const count = await KbChunkModel.countByDocument(doc.id);
      expect(count).toBe(2);
    });

    test("returns 0 when document has no chunks", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      const count = await KbChunkModel.countByDocument(doc.id);
      expect(count).toBe(0);
    });

    test("does not count chunks from other documents", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc1 = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );
      const doc2 = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        { documentId: doc1.id, content: "Doc1 chunk 0", chunkIndex: 0 },
        { documentId: doc1.id, content: "Doc1 chunk 1", chunkIndex: 1 },
        { documentId: doc2.id, content: "Doc2 chunk 0", chunkIndex: 0 },
      ]);

      const count = await KbChunkModel.countByDocument(doc1.id);
      expect(count).toBe(2);
    });
  });

  describe("vectorSearch", () => {
    test("returns empty array when connectorIds is empty", async () => {
      const results = await KbChunkModel.vectorSearch({
        connectorIds: [],
        queryEmbedding: [0.1, 0.2, 0.3],
        dimensions: 1536,
        userAcl: ["org:*"],
      });

      expect(results).toEqual([]);
    });

    test("returns empty array when userAcl is empty", async () => {
      const results = await KbChunkModel.vectorSearch({
        connectorIds: [crypto.randomUUID()],
        queryEmbedding: [0.1, 0.2, 0.3],
        dimensions: 1536,
        userAcl: [],
      });

      expect(results).toEqual([]);
    });

    // vectorSearch is not covered here: it needs the pgvector extension,
    // which PGlite does not provide. It is exercised against real Postgres.
  });

  describe("fullTextSearch", () => {
    test("returns matching chunks with document metadata and ACL filtering applied", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        connectorType: "github",
      });
      const allowedDoc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          title: "Allowed Doc",
          sourceUrl: "https://example.com/allowed",
          metadata: { category: "allowed" },
        }),
      );
      const blockedDoc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          title: "Blocked Doc",
          sourceUrl: "https://example.com/blocked",
          metadata: { category: "blocked" },
        }),
      );

      await KbChunkModel.insertMany([
        {
          documentId: allowedDoc.id,
          content: "apple banana apple",
          chunkIndex: 0,
          acl: ["team:alpha"],
        },
        {
          documentId: blockedDoc.id,
          content: "apple banana apple banana",
          chunkIndex: 0,
          acl: ["team:beta"],
        },
      ]);

      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "apple banana",
        userAcl: ["team:alpha"],
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        documentId: allowedDoc.id,
        title: "Allowed Doc",
        sourceUrl: "https://example.com/allowed",
        metadata: { category: "allowed" },
        connectorType: "github",
        chunkIndex: 0,
        content: "apple banana apple",
      });
      expect(results[0].score).toBeGreaterThan(0);
    });

    test("a multi-term query requires every term (AND semantics)", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );
      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "apple banana cherry",
          chunkIndex: 0,
          acl: ["org:*"],
        },
        {
          documentId: doc.id,
          content: "apple date",
          chunkIndex: 1,
          acl: ["org:*"],
        },
      ]);

      // Only the chunk containing BOTH terms matches — the always-OR rewrite
      // would have returned both, and its match set is what made the keyword
      // lane's cost scale with the corpus.
      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "apple banana",
        userAcl: ["org:*"],
      });
      expect(results.map((r) => r.chunkIndex)).toEqual([0]);
    });

    test("falls back to OR matching when no chunk holds every term", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );
      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "apple banana cherry",
          chunkIndex: 0,
          acl: ["org:*"],
        },
        {
          documentId: doc.id,
          content: "banana date",
          chunkIndex: 1,
          acl: ["org:*"],
        },
      ]);

      // "zzzabsent" appears nowhere, so the AND pass matches nothing; the OR
      // fallback recovers the chunks that hold any of the real terms.
      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "banana zzzabsent",
        userAcl: ["org:*"],
      });
      expect(results.map((r) => r.chunkIndex).sort()).toEqual([0, 1]);
    });

    test("returns empty array when connectorIds is empty", async () => {
      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [],
        queryText: "apple banana",
        userAcl: ["org:*"],
      });

      expect(results).toEqual([]);
    });

    test("returns empty array when userAcl is empty", async () => {
      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [crypto.randomUUID()],
        queryText: "apple banana",
        userAcl: [],
      });

      expect(results).toEqual([]);
    });

    test("bypasses ACL filtering when requested", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        connectorType: "github",
      });
      const alphaDoc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          title: "Alpha Doc",
        }),
      );
      const betaDoc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          title: "Beta Doc",
        }),
      );

      await KbChunkModel.insertMany([
        {
          documentId: alphaDoc.id,
          content: "apple alpha",
          chunkIndex: 0,
          acl: ["team:alpha"],
        },
        {
          documentId: betaDoc.id,
          content: "apple beta",
          chunkIndex: 0,
          acl: ["team:beta"],
        },
      ]);

      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "apple",
        userAcl: [],
        bypassAcl: true,
      });

      expect(results).toHaveLength(2);
      expect(results.map((result) => result.documentId).sort()).toEqual(
        [alphaDoc.id, betaDoc.id].sort(),
      );
    });
  });

  describe("updateAclByConnector", () => {
    test("updates chunks for the target connector only", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const targetConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Target Connector",
      });
      const otherConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Other Connector",
      });

      const targetDoc = await KbDocumentModel.create(
        createDocumentData(targetConnector.id, org.id),
      );
      const otherDoc = await KbDocumentModel.create(
        createDocumentData(otherConnector.id, org.id),
      );

      await KbChunkModel.insertMany([
        {
          documentId: targetDoc.id,
          content: "Target chunk",
          chunkIndex: 0,
          acl: ["org:*"],
        },
        {
          documentId: otherDoc.id,
          content: "Other chunk",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const updatedCount = await KbChunkModel.updateAclByConnector({
        connectorId: targetConnector.id,
        acl: ["team:alpha"],
        aclConfigEpoch: targetConnector.aclConfigEpoch,
      });

      expect(updatedCount).toBe(1);

      const targetChunks = await KbChunkModel.findByDocument(targetDoc.id);
      const otherChunks = await KbChunkModel.findByDocument(otherDoc.id);

      expect(targetChunks.map((chunk) => chunk.acl)).toEqual([["team:alpha"]]);
      expect(otherChunks.map((chunk) => chunk.acl)).toEqual([["org:*"]]);
    });

    test("skips chunks that already have the target ACL", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const targetConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Target Connector",
      });

      const unchangedDoc = await KbDocumentModel.create(
        createDocumentData(targetConnector.id, org.id, {
          acl: ["team:alpha"],
        }),
      );
      const changedDoc = await KbDocumentModel.create(
        createDocumentData(targetConnector.id, org.id, {
          acl: ["org:*"],
        }),
      );

      await KbChunkModel.insertMany([
        {
          documentId: unchangedDoc.id,
          content: "Already correct chunk",
          chunkIndex: 0,
          acl: ["team:alpha"],
        },
        {
          documentId: changedDoc.id,
          content: "Needs rewrite chunk",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const updatedCount = await KbChunkModel.updateAclByConnector({
        connectorId: targetConnector.id,
        acl: ["team:alpha"],
        aclConfigEpoch: targetConnector.aclConfigEpoch,
      });

      expect(updatedCount).toBe(1);

      const unchangedChunks = await KbChunkModel.findByDocument(
        unchangedDoc.id,
      );
      const changedChunks = await KbChunkModel.findByDocument(changedDoc.id);

      expect(unchangedChunks.map((chunk) => chunk.acl)).toEqual([
        ["team:alpha"],
      ]);
      expect(changedChunks.map((chunk) => chunk.acl)).toEqual([["team:alpha"]]);
    });
  });

  describe("fullTextSearch", () => {
    /**
     * The keyword index stems with the chunk's own text-search configuration.
     * "Katzen" in a German document only collapses to the same token as a
     * "Katze" query under the `german` configuration; indexed as English it
     * stays a distinct token and the document is silently unfindable.
     */
    test("a German corpus is found by a German query when indexed as german", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        ftsLanguage: "german",
      });
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "Die laufenden Katzen springen",
          chunkIndex: 0,
          ftsLanguage: "german",
          acl: ["org:*"],
        },
      ]);

      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "Katze",
        languages: await KbChunkModel.getTextSearchLanguages([connector.id]),
        userAcl: ["org:*"],
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Die laufenden Katzen springen");
    });

    test("the same German corpus indexed as english does not match", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "Die laufenden Katzen springen",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "Katze",
        languages: await KbChunkModel.getTextSearchLanguages([connector.id]),
        userAcl: ["org:*"],
      });

      expect(results).toHaveLength(0);
    });

    test("a mixed-language corpus matches under every configuration present", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const german = await makeKnowledgeBaseConnector(kb.id, org.id, {
        ftsLanguage: "german",
      });
      const english = await makeKnowledgeBaseConnector(kb.id, org.id);

      const germanDoc = await KbDocumentModel.create(
        createDocumentData(german.id, org.id),
      );
      const englishDoc = await KbDocumentModel.create(
        createDocumentData(english.id, org.id),
      );

      await KbChunkModel.insertMany([
        {
          documentId: germanDoc.id,
          content: "Die laufenden Katzen springen",
          chunkIndex: 0,
          ftsLanguage: "german",
          acl: ["org:*"],
        },
        {
          documentId: englishDoc.id,
          content: "The running cats jumped",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const connectorIds = [german.id, english.id];
      const languages = await KbChunkModel.getTextSearchLanguages(connectorIds);
      expect([...languages].sort()).toEqual(["english", "german"]);

      // The German query form only matches under German stemming, and the
      // search still reaches it while spanning an English connector too.
      const results = await KbChunkModel.fullTextSearch({
        connectorIds,
        queryText: "Katze",
        languages,
        userAcl: ["org:*"],
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Die laufenden Katzen springen");
      expect(results[0].score).toBeGreaterThan(0);
    });

    test("falls back to the default configuration when no languages are given", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "The running cats jumped",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "running",
        userAcl: ["org:*"],
      });

      expect(results).toHaveLength(1);
    });

    test("the contextual header is searchable alongside the chunk", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
      );

      // The chunk never names the subject; only the document-level context does.
      // This is the case contextual retrieval exists to fix.
      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "The limit was raised to 5,000 per minute.",
          chunkIndex: 0,
          contextualHeader:
            "CONTEXT: Runbook for the billing API rate limiter.\n\n",
          acl: ["org:*"],
        },
      ]);

      const results = await KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "billing rate limiter",
        userAcl: ["org:*"],
      });

      expect(results).toHaveLength(1);
      // The header is an indexing signal only; it never leaks into the text the
      // model is shown.
      expect(results[0].content).toBe(
        "The limit was raised to 5,000 per minute.",
      );
    });
  });

  describe("updateEmbeddings", () => {
    test("returns without error when updates is empty", async () => {
      await expect(
        KbChunkModel.updateEmbeddings([], 1536),
      ).resolves.toBeUndefined();
    });

    // updateEmbeddings writes vector columns, so it needs pgvector and is
    // likewise only exercised against real Postgres.
  });
});

describe("KbChunkModel document metadata filtering", () => {
  const QUERY = "deployment rollback";

  /**
   * Seed a corpus mirroring the shapes connectors actually write: a scalar key
   * (`spaceKey`, as Confluence writes it) and an array key (`labels`, which
   * Confluence and GitHub both write). Every chunk shares one query term, so
   * the metadata filter is the only thing that can separate them.
   */
  async function seedCorpus(connectorId: string, organizationId: string) {
    const current = await KbDocumentModel.create(
      createDocumentData(connectorId, organizationId, {
        title: "Current release runbook",
        metadata: { spaceKey: "DEV", labels: ["release-2.0", "runbook"] },
      }),
    );
    const legacy = await KbDocumentModel.create(
      createDocumentData(connectorId, organizationId, {
        title: "Legacy runbook",
        metadata: { spaceKey: "DEV", labels: ["release-1.0", "runbook"] },
      }),
    );
    const otherSpace = await KbDocumentModel.create(
      createDocumentData(connectorId, organizationId, {
        title: "Marketing runbook",
        metadata: { spaceKey: "MKT", labels: ["release-2.0"] },
      }),
    );

    await KbChunkModel.insertMany(
      [current, legacy, otherSpace].map((doc) => ({
        documentId: doc.id,
        content: "deployment rollback procedure",
        chunkIndex: 0,
        acl: ["org:*" as const],
      })),
    );

    return { current, legacy, otherSpace };
  }

  test("without a filter, every document in the connector is searched", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await seedCorpus(connector.id, org.id);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
    });

    expect(results).toHaveLength(3);
  });

  test("a scalar metadata value narrows the search", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const { current, legacy } = await seedCorpus(connector.id, org.id);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { spaceKey: "DEV" },
    });

    expect(new Set(results.map((r) => r.documentId))).toEqual(
      new Set([current.id, legacy.id]),
    );
  });

  test("an array metadata value matches membership, not equality", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const { current, otherSpace } = await seedCorpus(connector.id, org.id);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { labels: "release-2.0" },
    });

    expect(new Set(results.map((r) => r.documentId))).toEqual(
      new Set([current.id, otherSpace.id]),
    );
  });

  test("several keys are ANDed together", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const { current } = await seedCorpus(connector.id, org.id);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { spaceKey: "DEV", labels: "release-2.0" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].documentId).toBe(current.id);
  });

  test("several values for one key are ORed together", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const { current, legacy, otherSpace } = await seedCorpus(
      connector.id,
      org.id,
    );

    // Every document carries one of the two releases, so the OR matches all
    // three — including the one in another space, which is what distinguishes
    // this from the ANDed case below.
    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { labels: ["release-1.0", "release-2.0"] },
    });

    expect(new Set(results.map((r) => r.documentId))).toEqual(
      new Set([current.id, legacy.id, otherSpace.id]),
    );
  });

  test("a key no document carries returns nothing rather than everything", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await seedCorpus(connector.id, org.id);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { noSuchKey: "whatever" },
    });

    expect(results).toEqual([]);
  });

  test("an empty filter object is a no-op, not a match-nothing", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await seedCorpus(connector.id, org.id);

    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: {},
    });

    expect(results).toHaveLength(3);
  });

  test("matches numeric and boolean metadata written by connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // Shapes real connectors write: a JSON number and a JSON boolean, neither
    // of which a string-only containment test would match.
    const shallow = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, {
        metadata: { depth: 0, archived: false },
      }),
    );
    const deep = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, {
        metadata: { depth: 1, archived: true },
      }),
    );
    await KbChunkModel.insertMany(
      [shallow, deep].map((doc) => ({
        documentId: doc.id,
        content: "deployment rollback procedure",
        chunkIndex: 0,
        acl: ["org:*" as const],
      })),
    );

    const byDepth = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { depth: "0" },
    });
    expect(byDepth).toHaveLength(1);
    expect(byDepth[0].documentId).toBe(shallow.id);

    const byFlag = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { archived: "true" },
    });
    expect(byFlag).toHaveLength(1);
    expect(byFlag[0].documentId).toBe(deep.id);

    // A near-miss must not be coerced into a match.
    const nearMiss = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["org:*"],
      metadataFilter: { depth: "0.0" },
    });
    expect(nearMiss).toEqual([]);
  });

  test("a filter cannot widen past the ACL filter", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    const readable = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, {
        title: "Readable",
        metadata: { tier: "shared" },
      }),
    );
    const unreadable = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, {
        title: "Unreadable",
        metadata: { tier: "shared" },
      }),
    );
    await KbChunkModel.insertMany([
      {
        documentId: readable.id,
        content: "deployment rollback procedure",
        chunkIndex: 0,
        acl: ["team:alpha"],
      },
      {
        documentId: unreadable.id,
        content: "deployment rollback procedure",
        chunkIndex: 0,
        acl: ["team:beta"],
      },
    ]);

    // The filter selects BOTH documents; the ACL still admits only one.
    const results = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: QUERY,
      userAcl: ["team:alpha"],
      metadataFilter: { tier: "shared" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].documentId).toBe(readable.id);
  });
});
