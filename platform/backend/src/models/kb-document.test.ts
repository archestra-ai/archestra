import { describe, expect, test } from "@/test";
import type { InsertKbDocument } from "@/types";
import KbDocumentModel from "./kb-document";

function createDocumentData(
  knowledgeBaseId: string,
  organizationId: string,
  overrides: Partial<InsertKbDocument> = {},
): InsertKbDocument {
  const id = crypto.randomUUID().substring(0, 8);
  return {
    knowledgeBaseId,
    organizationId,
    sourceType: "api",
    title: `Test Document ${id}`,
    content: `Content for document ${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

describe("KbDocumentModel", () => {
  describe("create", () => {
    test("creates a document with required fields", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const doc = await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          title: "My Document",
          content: "Document content here",
          contentHash: "abc123",
        }),
      );

      expect(doc.id).toBeDefined();
      expect(doc.knowledgeBaseId).toBe(kb.id);
      expect(doc.organizationId).toBe(org.id);
      expect(doc.sourceType).toBe("api");
      expect(doc.title).toBe("My Document");
      expect(doc.content).toBe("Document content here");
      expect(doc.contentHash).toBe("abc123");
      expect(doc.embeddingStatus).toBe("pending");
      expect(doc.chunkCount).toBe(0);
      expect(doc.acl).toEqual([]);
      expect(doc.sourceId).toBeNull();
      expect(doc.connectorId).toBeNull();
      expect(doc.sourceUrl).toBeNull();
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    test("creates a document with optional fields", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const doc = await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          sourceType: "connector",
          sourceId: "JIRA-123",
          sourceUrl: "https://jira.example.com/JIRA-123",
          acl: ["team-a", "team-b"],
          metadata: { priority: "high" },
          embeddingStatus: "completed",
          chunkCount: 5,
        }),
      );

      expect(doc.sourceType).toBe("connector");
      expect(doc.sourceId).toBe("JIRA-123");
      expect(doc.sourceUrl).toBe("https://jira.example.com/JIRA-123");
      expect(doc.acl).toEqual(["team-a", "team-b"]);
      expect(doc.metadata).toEqual({ priority: "high" });
      expect(doc.embeddingStatus).toBe("completed");
      expect(doc.chunkCount).toBe(5);
    });
  });

  describe("findById", () => {
    test("returns a document by id", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { title: "Find Me" }),
      );

      const found = await KbDocumentModel.findById(doc.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(doc.id);
      expect(found?.title).toBe("Find Me");
    });

    test("returns null for non-existent id", async () => {
      const found = await KbDocumentModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("findByKnowledgeBase", () => {
    test("returns documents for a knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb.id,
      });

      expect(results).toHaveLength(2);
    });

    test("does not return documents from other knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb1.id, org.id, { title: "KB1 Doc" }),
      );
      await KbDocumentModel.create(
        createDocumentData(kb2.id, org.id, { title: "KB2 Doc" }),
      );

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb1.id,
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("KB1 Doc");
    });

    test("supports limit parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb.id,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    test("supports offset parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb.id,
        limit: 2,
        offset: 1,
      });

      expect(results).toHaveLength(2);
    });

    test("returns empty array when no documents exist", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb.id,
      });

      expect(results).toEqual([]);
    });
  });

  describe("findByContentHash", () => {
    test("returns a document matching knowledge base and content hash", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          title: "Hashed Doc",
          contentHash: "unique-hash-abc",
        }),
      );

      const found = await KbDocumentModel.findByContentHash({
        knowledgeBaseId: kb.id,
        contentHash: "unique-hash-abc",
      });

      expect(found).not.toBeNull();
      expect(found?.title).toBe("Hashed Doc");
      expect(found?.contentHash).toBe("unique-hash-abc");
    });

    test("returns null when content hash does not match", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { contentHash: "existing-hash" }),
      );

      const found = await KbDocumentModel.findByContentHash({
        knowledgeBaseId: kb.id,
        contentHash: "nonexistent-hash",
      });

      expect(found).toBeNull();
    });

    test("scopes content hash lookup to the knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb1.id, org.id, { contentHash: "shared-hash" }),
      );

      const found = await KbDocumentModel.findByContentHash({
        knowledgeBaseId: kb2.id,
        contentHash: "shared-hash",
      });

      expect(found).toBeNull();
    });
  });

  describe("findBySourceId", () => {
    test("returns a document matching knowledge base, source type, and source id", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          sourceType: "connector",
          sourceId: "JIRA-456",
          title: "Jira Issue",
        }),
      );

      const found = await KbDocumentModel.findBySourceId({
        knowledgeBaseId: kb.id,
        sourceType: "connector",
        sourceId: "JIRA-456",
      });

      expect(found).not.toBeNull();
      expect(found?.title).toBe("Jira Issue");
      expect(found?.sourceId).toBe("JIRA-456");
    });

    test("returns null when source id does not match", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          sourceType: "connector",
          sourceId: "JIRA-100",
        }),
      );

      const found = await KbDocumentModel.findBySourceId({
        knowledgeBaseId: kb.id,
        sourceType: "connector",
        sourceId: "JIRA-999",
      });

      expect(found).toBeNull();
    });

    test("scopes source id lookup to the knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb1.id, org.id, {
          sourceType: "connector",
          sourceId: "SHARED-ID",
        }),
      );

      const found = await KbDocumentModel.findBySourceId({
        knowledgeBaseId: kb2.id,
        sourceType: "connector",
        sourceId: "SHARED-ID",
      });

      expect(found).toBeNull();
    });

    test("differentiates by source type", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          sourceType: "api",
          sourceId: "DOC-1",
          title: "API Doc",
          contentHash: "hash-api",
        }),
      );
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, {
          sourceType: "connector",
          sourceId: "DOC-1",
          title: "Connector Doc",
          contentHash: "hash-connector",
        }),
      );

      const apiDoc = await KbDocumentModel.findBySourceId({
        knowledgeBaseId: kb.id,
        sourceType: "api",
        sourceId: "DOC-1",
      });

      const connectorDoc = await KbDocumentModel.findBySourceId({
        knowledgeBaseId: kb.id,
        sourceType: "connector",
        sourceId: "DOC-1",
      });

      expect(apiDoc?.title).toBe("API Doc");
      expect(connectorDoc?.title).toBe("Connector Doc");
    });
  });

  describe("update", () => {
    test("updates a document title", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { title: "Original Title" }),
      );

      const updated = await KbDocumentModel.update(doc.id, {
        title: "Updated Title",
      });

      expect(updated).not.toBeNull();
      expect(updated?.title).toBe("Updated Title");
      expect(updated?.content).toBe(doc.content);
    });

    test("updates embedding status", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(kb.id, org.id),
      );

      const updated = await KbDocumentModel.update(doc.id, {
        embeddingStatus: "completed",
        chunkCount: 10,
      });

      expect(updated?.embeddingStatus).toBe("completed");
      expect(updated?.chunkCount).toBe(10);
    });

    test("returns null for non-existent id", async () => {
      const updated = await KbDocumentModel.update(
        "00000000-0000-0000-0000-000000000000",
        { title: "Nope" },
      );
      expect(updated).toBeNull();
    });
  });

  describe("delete", () => {
    test("deletes a document", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(kb.id, org.id),
      );

      await KbDocumentModel.delete(doc.id);

      // Verify record is actually gone (PGlite may not return accurate rowCount)
      const found = await KbDocumentModel.findById(doc.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent id", async () => {
      const deleted = await KbDocumentModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(deleted).toBe(false);
    });
  });

  describe("countByKnowledgeBase", () => {
    test("returns the count of documents in a knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb.id, org.id));

      const count = await KbDocumentModel.countByKnowledgeBase(kb.id);
      expect(count).toBe(2);
    });

    test("returns 0 when no documents exist", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const count = await KbDocumentModel.countByKnowledgeBase(kb.id);
      expect(count).toBe(0);
    });

    test("does not count documents from other knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(createDocumentData(kb1.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb1.id, org.id));
      await KbDocumentModel.create(createDocumentData(kb2.id, org.id));

      const count = await KbDocumentModel.countByKnowledgeBase(kb1.id);
      expect(count).toBe(2);
    });
  });

  describe("findPending", () => {
    test("returns documents with pending embedding status", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "pending" }),
      );
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "completed" }),
      );
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "pending" }),
      );

      const pending = await KbDocumentModel.findPending({});

      expect(pending).toHaveLength(2);
      for (const doc of pending) {
        expect(doc.embeddingStatus).toBe("pending");
      }
    });

    test("respects the limit parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "pending" }),
      );
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "pending" }),
      );
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "pending" }),
      );

      const pending = await KbDocumentModel.findPending({ limit: 2 });

      expect(pending).toHaveLength(2);
    });

    test("defaults to limit of 10", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      // Create 12 pending documents
      for (let i = 0; i < 12; i++) {
        await KbDocumentModel.create(
          createDocumentData(kb.id, org.id, { embeddingStatus: "pending" }),
        );
      }

      const pending = await KbDocumentModel.findPending({});

      expect(pending).toHaveLength(10);
    });

    test("returns empty array when no pending documents exist", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await KbDocumentModel.create(
        createDocumentData(kb.id, org.id, { embeddingStatus: "completed" }),
      );

      const pending = await KbDocumentModel.findPending({});

      expect(pending).toEqual([]);
    });
  });
});
