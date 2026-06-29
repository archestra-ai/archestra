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

    test.skip("vectorSearch requires pgvector extension which is not available in PGlite test DB", async () => {});
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

      const updatedCount = await KbChunkModel.updateAclByConnector(
        targetConnector.id,
        ["team:alpha"],
      );

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

      const updatedCount = await KbChunkModel.updateAclByConnector(
        targetConnector.id,
        ["team:alpha"],
      );

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

  describe("updateEmbeddings", () => {
    test("returns without error when updates is empty", async () => {
      await expect(
        KbChunkModel.updateEmbeddings([], 1536),
      ).resolves.toBeUndefined();
    });

    test.skip("updateEmbeddings requires pgvector extension which is not available in PGlite test DB", async () => {});
  });
});
