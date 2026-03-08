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
    test.skip("vectorSearch requires pgvector extension which is not available in PGlite test DB", async () => {});
  });

  describe("updateEmbeddings", () => {
    test.skip("updateEmbeddings requires pgvector extension which is not available in PGlite test DB", async () => {});
  });
});
