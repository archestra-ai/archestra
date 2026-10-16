import { count, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { InsertKbDocument } from "@/types";
import KbChunkModel from "./kb-chunk";
import KbDocumentModel from "./kb-document";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";

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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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

  describe("findByConnectorSourcePairs", () => {
    test("returns documents matching connector and source id pairs", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb1.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb2.id, org.id);

      await KbDocumentModel.create(
        createDocumentData(connector1.id, org.id, {
          sourceId: "shared-source",
          title: "First connector document",
        }),
      );
      await KbDocumentModel.create(
        createDocumentData(connector2.id, org.id, {
          sourceId: "shared-source",
          title: "Second connector document",
        }),
      );
      await KbDocumentModel.create(
        createDocumentData(connector2.id, org.id, {
          sourceId: "other-source",
          title: "Other document",
        }),
      );

      const found = await KbDocumentModel.findByConnectorSourcePairs([
        { connectorId: connector1.id, sourceId: "shared-source" },
        { connectorId: connector2.id, sourceId: "other-source" },
      ]);

      expect(found.map((doc) => doc.title).sort()).toEqual([
        "First connector document",
        "Other document",
      ]);
    });
  });

  describe("update", () => {
    test("updates a document title", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
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
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const count = await KbDocumentModel.deleteByConnector(connector.id);

      // PGlite may return 0
      expect(count).toBe(0);
    });
  });

  describe("updateAclByConnector", () => {
    test("updates only documents whose ACL differs from the target ACL", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const targetConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Target Connector",
      });
      const otherConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
        name: "Other Connector",
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
      const otherDoc = await KbDocumentModel.create(
        createDocumentData(otherConnector.id, org.id, {
          acl: ["org:*"],
        }),
      );

      const updatedCount = await KbDocumentModel.updateAclByConnector({
        connectorId: targetConnector.id,
        acl: ["team:alpha"],
        aclConfigEpoch: targetConnector.aclConfigEpoch,
      });

      expect(updatedCount).toBe(1);
      expect((await KbDocumentModel.findById(unchangedDoc.id))?.acl).toEqual([
        "team:alpha",
      ]);
      expect((await KbDocumentModel.findById(changedDoc.id))?.acl).toEqual([
        "team:alpha",
      ]);
      expect((await KbDocumentModel.findById(otherDoc.id))?.acl).toEqual([
        "org:*",
      ]);
    });
  });

  describe("recoverStalledEmbeddings", () => {
    test("resets stalled pending/processing docs to pending and returns their ids", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const pending = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          embeddingStatus: "pending",
        }),
      );
      const processing = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          embeddingStatus: "processing",
        }),
      );

      // Age both rows so they are unambiguously stale. A just-created row can
      // share the sweep query's transaction timestamp, so `updated_at < now()`
      // would drop it — the source of prior CI flakiness with `olderThanSeconds: 0`.
      await db.execute(
        sql`UPDATE kb_documents SET updated_at = now() - interval '1 hour' WHERE connector_id = ${connector.id}`,
      );

      const ids = await KbDocumentModel.recoverStalledEmbeddings({
        olderThanSeconds: 0,
        limit: 10,
      });

      expect(ids.sort()).toEqual([pending.id, processing.id].sort());
      // The stuck 'processing' row is reset to 'pending' so the embedder re-runs it.
      expect(
        (await KbDocumentModel.findById(processing.id))?.embeddingStatus,
      ).toBe("pending");
    });

    test("ignores documents touched within the window", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          embeddingStatus: "pending",
        }),
      );

      // Freshly created → newer than a 1-hour window → not swept.
      const ids = await KbDocumentModel.recoverStalledEmbeddings({
        olderThanSeconds: 3600,
        limit: 10,
      });

      expect(ids).toHaveLength(0);
    });

    test("does not touch completed or failed documents", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          embeddingStatus: "completed",
        }),
      );
      await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, { embeddingStatus: "failed" }),
      );

      const ids = await KbDocumentModel.recoverStalledEmbeddings({
        olderThanSeconds: 0,
        limit: 10,
      });

      expect(ids).toHaveLength(0);
    });

    test("respects the limit", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      for (let i = 0; i < 3; i++) {
        await KbDocumentModel.create(
          createDocumentData(connector.id, org.id, {
            embeddingStatus: "pending",
          }),
        );
      }
      // Age all three so they are unambiguously stale (see the note above).
      await db.execute(
        sql`UPDATE kb_documents SET updated_at = now() - interval '1 hour' WHERE connector_id = ${connector.id}`,
      );

      const ids = await KbDocumentModel.recoverStalledEmbeddings({
        olderThanSeconds: 0,
        limit: 2,
      });

      expect(ids).toHaveLength(2);
    });
  });

  describe("applyContainerAssignment", () => {
    /** Seed a document with one chunk, both fail-closed. */
    async function seedDocWithChunk(params: {
      connectorId: string;
      organizationId: string;
    }) {
      const doc = await KbDocumentModel.create(
        createDocumentData(params.connectorId, params.organizationId, {
          acl: [],
        }),
      );
      await KbChunkModel.insertMany([
        { documentId: doc.id, content: "chunk", chunkIndex: 0, acl: [] },
      ]);
      return doc;
    }

    const chunkAcls = async (documentId: string) =>
      (
        await db.execute<{ acl: string[] }>(
          sql`SELECT acl FROM kb_chunks WHERE document_id = ${documentId}`,
        )
      ).rows.map((row) => row.acl);

    test("moves the document row and its chunks together, reporting both", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await seedDocWithChunk({
        connectorId: connector.id,
        organizationId: org.id,
      });

      const result = await KbDocumentModel.applyContainerAssignment({
        documentId: doc.id,
        connectorId: connector.id,
        acl: ["container:x"],
        containerKey: "repo:o/r",
        aclConfigEpoch: connector.aclConfigEpoch,
      });

      expect(result).toEqual({ documentUpdated: true, chunksRewritten: 1 });
      const stored = await KbDocumentModel.findById(doc.id);
      expect(stored?.acl).toEqual(["container:x"]);
      expect(stored?.containerKey).toBe("repo:o/r");
      expect(await chunkAcls(doc.id)).toEqual([["container:x"]]);
    });

    test("a stale epoch fences out the document AND its chunks — never one without the other", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      // The invariant this method exists for. As two separately-fenced
      // statements, a visibility switch landing between them fenced out only the
      // second: the chunks (which the search filter actually reads) kept a
      // container token the document row never got. One statement, one fence
      // evaluation, so the pair cannot come apart.
      const org = await makeOrganization({ legacyPermissions: true });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
      const doc = await seedDocWithChunk({
        connectorId: connector.id,
        organizationId: org.id,
      });

      const result = await KbDocumentModel.applyContainerAssignment({
        documentId: doc.id,
        connectorId: connector.id,
        acl: ["container:x"],
        containerKey: "repo:o/r",
        aclConfigEpoch: connector.aclConfigEpoch + 1,
      });

      expect(result).toEqual({ documentUpdated: false, chunksRewritten: 0 });
      const stored = await KbDocumentModel.findById(doc.id);
      expect(stored?.acl).toEqual([]);
      expect(stored?.containerKey).toBeNull();
      expect(await chunkAcls(doc.id)).toEqual([[]]);
    });
  });
});

describe("KbDocumentModel.findMetadataFacetValues", () => {
  test("returns the values actually present, flattening arrays and skipping absent keys", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    // Upstream ACL tokens decide only for an auto-sync connector; any other
    // connector is reached through its grants.
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      syncPermissionsFromSource: true,
    });

    const docs = [
      { spaceKey: "DEV", labels: ["release-2.0", "runbook"] },
      { spaceKey: "DEV", labels: ["release-1.0"] },
      { spaceKey: "MKT", labels: [] as string[] },
      { spaceKey: null },
    ];
    for (const metadata of docs) {
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, { metadata }),
      );
      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "body",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);
    }

    const facets = await KbDocumentModel.findMetadataFacetValues({
      connectorIds: [connector.id],
      keys: ["spaceKey", "labels", "neverUsed"],
      userAcl: ["org:*"],
    });

    // DEV first: ordered by document count, so the model sees the common value.
    expect(facets.get("spaceKey")).toEqual(["DEV", "MKT"]);
    expect(facets.get("labels")).toEqual([
      "release-1.0",
      "release-2.0",
      "runbook",
    ]);
    // A JSON null contributes nothing, and neither does a key nobody uses.
    expect(facets.has("neverUsed")).toBe(false);
  });

  test("never discloses a value that only appears on unreadable documents", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    // Upstream ACL tokens decide only for an auto-sync connector; any other
    // connector is reached through its grants.
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      syncPermissionsFromSource: true,
    });

    const readable = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, {
        metadata: { project: "public-project" },
      }),
    );
    const secret = await KbDocumentModel.create(
      createDocumentData(connector.id, org.id, {
        metadata: { project: "codename-secret" },
      }),
    );
    await KbChunkModel.insertMany([
      {
        documentId: readable.id,
        content: "body",
        chunkIndex: 0,
        acl: ["team:alpha"],
      },
      {
        documentId: secret.id,
        content: "body",
        chunkIndex: 0,
        acl: ["team:beta"],
      },
    ]);

    const facets = await KbDocumentModel.findMetadataFacetValues({
      connectorIds: [connector.id],
      keys: ["project"],
      userAcl: ["team:alpha"],
    });

    expect(facets.get("project")).toEqual(["public-project"]);
  });

  test("caps the values returned per key", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    // Upstream ACL tokens decide only for an auto-sync connector; any other
    // connector is reached through its grants.
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      syncPermissionsFromSource: true,
    });

    for (let i = 0; i < 8; i++) {
      const doc = await KbDocumentModel.create(
        createDocumentData(connector.id, org.id, {
          metadata: { ticket: `TICKET-${i}` },
        }),
      );
      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "body",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);
    }

    const facets = await KbDocumentModel.findMetadataFacetValues({
      connectorIds: [connector.id],
      keys: ["ticket"],
      userAcl: ["org:*"],
      limitPerKey: 3,
    });

    expect(facets.get("ticket")).toHaveLength(3);
  });
});

describe("KbDocumentModel stored document counts", () => {
  test("follow inserts, including one statement spanning connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id);
    const b = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KbDocumentModel.create(createDocumentData(a.id, org.id));
    await db
      .insert(schema.kbDocumentsTable)
      .values([
        createDocumentData(a.id, org.id),
        createDocumentData(b.id, org.id),
        createDocumentData(b.id, org.id),
      ]);

    expect(await KbDocumentModel.countByConnector(a.id)).toBe(2);
    expect(await KbDocumentModel.countByConnector(b.id)).toBe(2);
    await expectStoredCountsMatchLive([a.id, b.id]);
  });

  test("follow every delete path", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id);
    const b = await makeKnowledgeBaseConnector(kb.id, org.id);
    const ids = [a.id, b.id];
    const docs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        KbDocumentModel.create(
          createDocumentData(i < 9 ? a.id : b.id, org.id, {
            sourceId: `src-${i}`,
            title: i % 2 === 0 ? `Even ${i}` : `Odd ${i}`,
            metadata: { driveId: i < 3 ? "drive-1" : "drive-2", gen: "g1" },
          }),
        ),
      ),
    );
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.delete(docs[0].id);
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.deleteByConnectorAndSources({
      connectorId: a.id,
      targets: [
        { sourceId: "src-1" },
        {
          sourceId: "src-2",
          sourceScope: { metadataField: "driveId", value: "drive-1" },
        },
      ],
    });
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.deleteMissingFromMetadataScope({
      connectorId: a.id,
      metadataFilter: { driveId: "drive-2" },
      seenSourceIds: ["src-3", "src-4"],
    });
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.update(docs[3].id, {
      metadata: { driveId: "drive-2", gen: "g2" },
    });
    await KbDocumentModel.deleteOutsideMetadataGeneration({
      connectorId: a.id,
      metadataKey: "gen",
      generation: "g2",
    });
    expect(await KbDocumentModel.countByConnector(a.id)).toBe(1);
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.deleteByConnectorFilter({
      connectorId: b.id,
      organizationId: org.id,
      search: "Even",
    });
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.deleteByConnector(b.id);
    expect(await KbDocumentModel.countByConnector(b.id)).toBe(0);
    await expectStoredCountsMatchLive(ids);

    await KbDocumentModel.deleteByOrganization(org.id);
    expect(await KbDocumentModel.countByConnector(a.id)).toBe(0);
    await expectStoredCountsMatchLive(ids);
  });

  test("move with a document whose connector changes and ignore other updates", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id);
    const b = await makeKnowledgeBaseConnector(kb.id, org.id);
    const doc = await KbDocumentModel.create(createDocumentData(a.id, org.id));
    await KbDocumentModel.create(createDocumentData(a.id, org.id));

    await KbDocumentModel.update(doc.id, { embeddingStatus: "completed" });
    expect(await KbDocumentModel.countByConnector(a.id)).toBe(2);

    // The model's update does not accept connectorId, but the trigger covers
    // any writer of kb_documents.
    await db
      .update(schema.kbDocumentsTable)
      .set({ connectorId: b.id })
      .where(eq(schema.kbDocumentsTable.id, doc.id));
    expect(await KbDocumentModel.countByConnector(a.id)).toBe(1);
    expect(await KbDocumentModel.countByConnector(b.id)).toBe(1);
    await expectStoredCountsMatchLive([a.id, b.id]);
  });

  test("are removed with a purged connector and cleared by truncate", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id);
    const b = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KbDocumentModel.create(createDocumentData(a.id, org.id));
    await KbDocumentModel.create(createDocumentData(b.id, org.id));

    await KnowledgeBaseConnectorModel.delete(a.id);
    await KnowledgeBaseConnectorModel.purge({
      id: a.id,
      organizationId: org.id,
    });
    expect(await storedCountRows()).toEqual([
      { connector_id: b.id, document_count: 1 },
    ]);

    await db.execute(sql`TRUNCATE kb_documents CASCADE`);
    expect(await storedCountRows()).toEqual([]);
  });

  test("countByKnowledgeBaseIds sums assigned connectors, soft-deleted ones included", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const kb = await makeKnowledgeBase(org.id);
    const emptyKb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id);
    const b = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KbDocumentModel.create(createDocumentData(a.id, org.id));
    await KbDocumentModel.create(createDocumentData(a.id, org.id));
    await KbDocumentModel.create(createDocumentData(b.id, org.id));
    await KnowledgeBaseConnectorModel.delete(b.id);

    const counts = await KbDocumentModel.countByKnowledgeBaseIds([
      kb.id,
      emptyKb.id,
    ]);

    expect(counts).toEqual(new Map([[kb.id, 3]]));
  });
});

/** Compare the trigger-maintained counts against a live count of documents. */
async function expectStoredCountsMatchLive(connectorIds: string[]) {
  for (const connectorId of connectorIds) {
    const [live] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));
    expect(await KbDocumentModel.countByConnector(connectorId)).toBe(
      live.count,
    );
  }
}

async function storedCountRows() {
  const { rows } = await db.execute<{
    connector_id: string;
    document_count: number;
  }>(
    sql`SELECT connector_id, document_count::int AS document_count FROM kb_connector_document_counts ORDER BY connector_id`,
  );
  return rows;
}
