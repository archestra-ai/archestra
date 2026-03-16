import { describe, expect, test } from "@/test";
import type { InsertKbDocument } from "@/types";
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

describe("KbDocumentModel", () => {
  describe("create", () => {
    test("creates a document with required fields", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          title: "My Document",
          content: "Document content here",
          contentHash: "abc123",
        }),
      );

      expect(doc.id).toBeDefined();
      expect(doc.connectorId).toBe(connector.id);
      expect(doc.organizationId).toBe(org.id);
      expect(doc.title).toBe("My Document");
      expect(doc.content).toBe("Document content here");
      expect(doc.contentHash).toBe("abc123");
      expect(doc.embeddingStatus).toBe("pending");
      expect(doc.chunkCount).toBe(0);
      expect(doc.acl).toEqual([]);
      expect(doc.sourceId).toBeNull();
      expect(doc.sourceUrl).toBeNull();
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    test("creates a document with optional fields", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          sourceId: "JIRA-123",
          sourceUrl: "https://jira.example.com/JIRA-123",
          acl: ["team-a", "team-b"],
          metadata: { priority: "high" },
          embeddingStatus: "completed",
          chunkCount: 5,
        }),
      );

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
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, { title: "Find Me" }),
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
    test("returns documents for a knowledge base via connector assignment", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb.id,
      });

      expect(results).toHaveLength(2);
    });

    test("does not return documents from other knowledge bases", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);
      await KbDocumentModel.create(
        createDocumentData(connector1.id, org.id, { title: "KB1 Doc" }),
      );
      await KbDocumentModel.create(
        createDocumentData(connector2.id, org.id, { title: "KB2 Doc" }),
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
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));

      const results = await KbDocumentModel.findByKnowledgeBase({
        knowledgeBaseId: kb.id,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    test("supports offset parameter", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));

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

  describe("findBySourceId", () => {
    test("returns a document matching connector and source id", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          sourceId: "JIRA-456",
          title: "Jira Issue",
        }),
      );

      const found = await KbDocumentModel.findBySourceId({
        connectorId: connector.id,
        sourceId: "JIRA-456",
      });

      expect(found).not.toBeNull();
      expect(found?.title).toBe("Jira Issue");
      expect(found?.sourceId).toBe("JIRA-456");
    });

    test("returns null when source id does not match", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          sourceId: "JIRA-100",
        }),
      );

      const found = await KbDocumentModel.findBySourceId({
        connectorId: connector.id,
        sourceId: "JIRA-999",
      });

      expect(found).toBeNull();
    });

    test("scopes source id lookup to the connector", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);
      await KbDocumentModel.create(
        createDocumentData(connector1.id, org.id, {
          sourceId: "SHARED-ID",
        }),
      );

      const found = await KbDocumentModel.findBySourceId({
        connectorId: connector2.id,
        sourceId: "SHARED-ID",
      });

      expect(found).toBeNull();
    });
  });

  describe("update", () => {
    test("updates a document title", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, { title: "Original Title" }),
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
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
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
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id),
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

  describe("deleteByConnector", () => {
    test("deletes all documents for a connector", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));

      await KbDocumentModel.deleteByConnector(connector.id);

      const count = await KbDocumentModel.countByConnector(connector.id);
      expect(count).toBe(0);
    });

    test("does not delete documents from other connectors", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector1.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector2.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector2.id, org.id));

      await KbDocumentModel.deleteByConnector(connector1.id);

      const count1 = await KbDocumentModel.countByConnector(connector1.id);
      const count2 = await KbDocumentModel.countByConnector(connector2.id);
      expect(count1).toBe(0);
      expect(count2).toBe(2);
    });

    test("returns 0 when connector has no documents", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const count = await KbDocumentModel.deleteByConnector(connector.id);

      // PGlite may return 0
      expect(count).toBe(0);
    });
  });

  describe("countByKnowledgeBase", () => {
    test("returns the count of documents in a knowledge base", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector.id, org.id));

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
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);
      await KbDocumentModel.create(createDocumentData(connector1.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector1.id, org.id));
      await KbDocumentModel.create(createDocumentData(connector2.id, org.id));

      const count = await KbDocumentModel.countByKnowledgeBase(kb1.id);
      expect(count).toBe(2);
    });
  });
});
