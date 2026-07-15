import {
  ADMIN_ROLE_NAME,
  PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import config from "@/config";
import db from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import { buildGroupToken } from "@/knowledge-base/acl-tokens";
import {
  ConnectorRunModel,
  GithubAppConfigModel,
  KbChunkModel,
  KbContainerAclModel,
  KbDocumentModel,
  KbExternalUserGroupModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";

describe("knowledge base routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    // The auto-sync-permissions routes are beta-gated; the suite runs with the
    // gate open, and the dedicated flag-off tests close it per test.
    config.kb.autoSyncPermissionsEnabled = true;
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  // ===== Knowledge Base CRUD =====

  describe("POST /api/knowledge-bases", () => {
    test("creates a knowledge base", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-bases",
        payload: { name: "Test KB" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("id");
      expect(body.name).toBe("Test KB");
      expect(body.organizationId).toBe(organizationId);
      expect(body).toHaveProperty("createdAt");
      expect(body).toHaveProperty("updatedAt");
    });

    test("creates a knowledge base with description", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-bases",
        payload: { name: "KB With Desc", description: "A useful description" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe("KB With Desc");
      expect(body.description).toBe("A useful description");
    });

    test("returns 400 when name is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-bases",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 400 when name is empty string", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge-bases",
        payload: { name: "" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/knowledge-bases/:id", () => {
    test("gets a knowledge base by ID", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Fetch KB",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${kb.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(kb.id);
      expect(body.name).toBe("Fetch KB");
    });

    test("returns 404 for non-existent knowledge base", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 404 for knowledge base in another organization", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const kb = await KnowledgeBaseModel.create({
        organizationId: otherOrg.id,
        name: "Other Org KB",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${kb.id}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/connectors/:id/documents", () => {
    test("lists documents for a connector with pagination metadata", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Connector Docs",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-docs.atlassian.net",
          isCloud: true,
          projectKey: "CD",
        },
      });
      const otherConnector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Other Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://other-connector.atlassian.net",
          isCloud: true,
          projectKey: "OC",
        },
      });

      await KbDocumentModel.create({
        organizationId,
        sourceId: "connector-doc-1",
        connectorId: connector.id,
        title: "Connector Alpha",
        content: "alpha",
        contentHash: "hash-connector-alpha",
        acl: ["org:*"],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "connector-doc-2",
        connectorId: connector.id,
        title: "Connector Beta",
        content: "beta",
        contentHash: "hash-connector-beta",
        acl: ["org:*"],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "other-connector-doc",
        connectorId: otherConnector.id,
        title: "Other Connector Doc",
        content: "other",
        contentHash: "hash-other-connector",
        acl: ["org:*"],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/documents?limit=1&offset=0`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ connectorId: string; connectorType: string }>;
        pagination: { total: number; hasNext: boolean };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        connectorId: connector.id,
        connectorType: "jira",
      });
      expect(body.data[0]).not.toHaveProperty("content");
      expect(body.pagination.total).toBe(2);
      expect(body.pagination.hasNext).toBe(true);
    });

    test("filters connector documents by title search", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Search Connector Docs",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-search.atlassian.net",
          isCloud: true,
          projectKey: "CS",
        },
      });

      await KbDocumentModel.create({
        organizationId,
        sourceId: "connector-search-1",
        connectorId: connector.id,
        title: "Roadmap Planning",
        content: "roadmap",
        contentHash: "hash-roadmap",
        acl: ["org:*"],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "connector-search-2",
        connectorId: connector.id,
        title: "Release Notes",
        content: "release",
        contentHash: "hash-connector-release",
        acl: ["org:*"],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/documents?limit=20&offset=0&search=roadmap`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ title: string }>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(1);
      expect(body.data.map((doc) => doc.title)).toEqual(["Roadmap Planning"]);
    });

    test("filters connector documents by upstream group across both ACL forms", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Group Filter Docs",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-group.atlassian.net",
          isCloud: true,
          projectKey: "GF",
        },
      });
      const token = buildGroupToken({
        connectorType: "jira",
        groupId: "eng",
      });

      // Container-indirected form: the group grant lives on the container row.
      await KbContainerAclModel.upsertMany([
        {
          organizationId,
          connectorId: connector.id,
          containerKey: "project:GF",
          acl: [token],
        },
        {
          organizationId,
          connectorId: connector.id,
          containerKey: "project:OTHER",
          acl: ["org:*"],
        },
      ]);
      await KbDocumentModel.create({
        organizationId,
        sourceId: "group-doc-1",
        connectorId: connector.id,
        title: "Granted via container",
        content: "a",
        contentHash: "hash-group-1",
        acl: [`container:${connector.id}:project:GF`],
        containerKey: "project:GF",
      });
      // Legacy materialized form: the group token sits on the document ACL.
      await KbDocumentModel.create({
        organizationId,
        sourceId: "group-doc-2",
        connectorId: connector.id,
        title: "Granted directly",
        content: "b",
        contentHash: "hash-group-2",
        acl: [token],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "group-doc-3",
        connectorId: connector.id,
        title: "Not granted",
        content: "c",
        contentHash: "hash-group-3",
        acl: [`container:${connector.id}:project:OTHER`],
        containerKey: "project:OTHER",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/documents?limit=20&offset=0&group=eng`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ title: string }>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(2);
      expect(body.data.map((doc) => doc.title).sort()).toEqual([
        "Granted directly",
        "Granted via container",
      ]);
    });
  });

  describe("GET /api/connectors/:id/documents/:docId", () => {
    test("gets a single connector document including content", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Connector Doc Detail",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-detail.atlassian.net",
          isCloud: true,
          projectKey: "CDD",
        },
      });
      const document = await KbDocumentModel.create({
        organizationId,
        sourceId: "connector-detail-doc",
        connectorId: connector.id,
        title: "Connector Detail",
        content: "connector detail content",
        contentHash: "hash-connector-detail",
        acl: ["org:*"],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/documents/${document.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: document.id,
        content: "connector detail content",
        connectorType: "jira",
      });
    });

    test("returns 404 when document belongs to another connector", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Connector Detail A",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-detail-a.atlassian.net",
          isCloud: true,
          projectKey: "CDA",
        },
      });
      const otherConnector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Connector Detail B",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-detail-b.atlassian.net",
          isCloud: true,
          projectKey: "CDB",
        },
      });
      const otherDocument = await KbDocumentModel.create({
        organizationId,
        sourceId: "other-detail-doc",
        connectorId: otherConnector.id,
        title: "Other Detail",
        content: "other detail content",
        contentHash: "hash-other-detail",
        acl: ["org:*"],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/documents/${otherDocument.id}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/connectors/:id/documents/:docId", () => {
    test("deletes a connector document and cascades to chunks", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Connector Delete Docs",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://connector-delete.atlassian.net",
          isCloud: true,
          projectKey: "CDD",
        },
      });
      const document = await KbDocumentModel.create({
        organizationId,
        sourceId: "connector-delete-doc",
        connectorId: connector.id,
        title: "Delete Connector Doc",
        content: "delete connector content",
        contentHash: "hash-delete-connector",
        acl: ["org:*"],
      });
      await KbChunkModel.insertMany([
        {
          documentId: document.id,
          content: "connector delete chunk",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}/documents/${document.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(await KbDocumentModel.findById(document.id)).toBeNull();
      expect(await KbChunkModel.findByDocument(document.id)).toEqual([]);
    });
  });

  describe("GET /api/knowledge-bases", () => {
    test("lists knowledge bases with pagination", async () => {
      await KnowledgeBaseModel.create({ organizationId, name: "KB A" });
      await KnowledgeBaseModel.create({ organizationId, name: "KB B" });

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-bases?limit=50&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);

      const names = body.data.map((kb: { name: string }) => kb.name);
      expect(names).toContain("KB A");
      expect(names).toContain("KB B");

      expect(body.pagination).toHaveProperty("total");
      expect(body.pagination).toHaveProperty("currentPage");
      expect(body.pagination).toHaveProperty("totalPages");
      expect(body.pagination).toHaveProperty("hasNext");
      expect(body.pagination).toHaveProperty("hasPrev");
    });

    test("respects pagination limits", async () => {
      await KnowledgeBaseModel.create({ organizationId, name: "Page KB 1" });
      await KnowledgeBaseModel.create({ organizationId, name: "Page KB 2" });
      await KnowledgeBaseModel.create({ organizationId, name: "Page KB 3" });

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-bases?limit=2&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.length).toBe(2);
      expect(body.pagination.total).toBeGreaterThanOrEqual(3);
      expect(body.pagination.hasNext).toBe(true);
    });

    test("does not return knowledge bases from other organizations", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      await KnowledgeBaseModel.create({
        organizationId: otherOrg.id,
        name: "Other Org KB",
      });
      await KnowledgeBaseModel.create({
        organizationId,
        name: "My KB",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-bases?limit=50&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.data.map((kb: { name: string }) => kb.name);
      expect(names).toContain("My KB");
      expect(names).not.toContain("Other Org KB");
    });

    test("includes connector summaries in list response", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "KB With Connector",
      });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Listed Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-bases?limit=50&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const kbResult = body.data.find(
        (item: { id: string }) => item.id === kb.id,
      );
      expect(kbResult).toBeDefined();
      expect(kbResult.connectors).toHaveLength(1);
      expect(kbResult.connectors[0].name).toBe("Listed Connector");
      expect(kbResult.connectors[0].connectorType).toBe("jira");
    });
  });

  describe("PUT /api/knowledge-bases/:id", () => {
    test("updates a knowledge base name", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Original Name",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/knowledge-bases/${kb.id}`,
        payload: { name: "Updated Name" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(kb.id);
      expect(body.name).toBe("Updated Name");
    });

    test("persists updates across reads", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Before Update",
      });

      await app.inject({
        method: "PUT",
        url: `/api/knowledge-bases/${kb.id}`,
        payload: { name: "After Update" },
      });

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${kb.id}`,
      });

      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json().name).toBe("After Update");
    });

    test("returns 404 for non-existent knowledge base", async () => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/knowledge-bases/${crypto.randomUUID()}`,
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/knowledge-bases/:id", () => {
    test("deletes a knowledge base", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "To Delete",
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/knowledge-bases/${kb.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    test("returns 404 on re-fetch after deletion", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Delete Then Fetch",
      });

      await app.inject({
        method: "DELETE",
        url: `/api/knowledge-bases/${kb.id}`,
      });

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${kb.id}`,
      });

      expect(getResponse.statusCode).toBe(404);
    });

    test("returns 404 for non-existent knowledge base", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/knowledge-bases/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ===== Connector Routes (read-only, no secretManager/taskQueueService) =====

  describe("GET /api/connectors/:id", () => {
    test("gets a connector by ID", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Get Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(connector.id);
      expect(body.name).toBe("Get Connector");
      expect(body.connectorType).toBe("jira");
      expect(body).toHaveProperty("totalDocsIngested");
    });

    test("returns 404 for non-existent connector", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 404 for connector in another organization", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId: otherOrg.id,
        name: "Other Org Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://other.atlassian.net",
          isCloud: true,
          projectKey: "OTHER",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/connectors", () => {
    test("rejects team-scoped connectors without teamIds", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Invalid Scoped Connector",
          connectorType: "jira",
          visibility: "team-scoped",
          teamIds: [],
          config: {
            type: "jira",
            jiraBaseUrl: "https://test.atlassian.net",
            isCloud: true,
            projectKey: "TEST",
          },
          credentials: {
            email: "user@example.com",
            apiToken: "token",
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "At least one team must be selected for team-scoped connectors",
      );
    });

    test("rejects team-scoped connector creation without enterprise license", async () => {
      const original = config.enterpriseFeatures.knowledgeBase;
      Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
        value: false,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(9999);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/connectors",
          payload: {
            name: "Enterprise Scoped Connector",
            connectorType: "jira",
            visibility: "team-scoped",
            teamIds: [crypto.randomUUID()],
            config: {
              type: "jira",
              jiraBaseUrl: "https://test.atlassian.net",
              isCloud: true,
              projectKey: "TEST",
            },
            credentials: {
              email: "user@example.com",
              apiToken: "token",
            },
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.message).toContain(
          "Team-scoped connectors require an enterprise license",
        );
      } finally {
        Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
          value: original,
          writable: true,
          configurable: true,
        });
        enterpriseTier.setUserCountForTesting(0);
      }
    });

    test("rejects auto-sync-permissions connector creation without enterprise license", async () => {
      const original = config.enterpriseFeatures.knowledgeBase;
      Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
        value: false,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(9999);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/connectors",
          payload: {
            name: "Auto-sync Connector",
            connectorType: "jira",
            visibility: "auto-sync-permissions",
            teamIds: [],
            config: {
              type: "jira",
              jiraBaseUrl: "https://test.atlassian.net",
              isCloud: true,
              projectKey: "TEST",
            },
            credentials: { email: "user@example.com", apiToken: "token" },
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.message).toContain(
          "Auto-sync-permissions connectors require an enterprise license",
        );
      } finally {
        Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
          value: original,
          writable: true,
          configurable: true,
        });
        enterpriseTier.setUserCountForTesting(0);
      }
    });

    test("rejects auto-sync-permissions for a supported connector type when the knowledge-base tier is inactive", async () => {
      // github IS a permission-sync connector, so the 403 here proves the tier
      // gate (not the connector-type gate) is what blocks the request.
      const original = config.enterpriseFeatures.knowledgeBase;
      Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
        value: false,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(9999);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/connectors",
          payload: {
            name: "Auto-sync GitHub Connector",
            connectorType: "github",
            visibility: "auto-sync-permissions",
            teamIds: [],
            config: {
              type: "github",
              githubUrl: "https://api.github.com",
              owner: "test-org",
              authMethod: "pat",
            },
            credentials: { apiToken: "ghp_token" },
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.message).toContain(
          "Auto-sync-permissions connectors require an enterprise license",
        );
      } finally {
        Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
          value: original,
          writable: true,
          configurable: true,
        });
        enterpriseTier.setUserCountForTesting(0);
      }
    });

    test("rejects auto-sync-permissions for a connector type that does not support it", async () => {
      // notion is not a permission-sync connector (Stage 1: jira/confluence/github;
      // Stage 2: gdrive/salesforce/sharepoint) — so this must 400.
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Auto-sync Notion",
          connectorType: "notion",
          visibility: "auto-sync-permissions",
          teamIds: [],
          config: { type: "notion" },
          credentials: { apiToken: "token" },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "Auto-sync permissions is not supported for notion connectors",
      );
    });

    test("rejects auto-sync-permissions creation for a member without the dedicated permission", async ({
      makeMember,
    }) => {
      // Default member role: knowledgeSource create, but no
      // knowledgeSourceAutoSync grants.
      await makeMember(user.id, organizationId);
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Member Auto-sync",
          connectorType: "github",
          visibility: "auto-sync-permissions",
          teamIds: [],
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "pat",
          },
          credentials: { apiToken: "ghp_token" },
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain(
        '"create" permission for auto-sync-permissions connectors',
      );
    });

    test("allows an admin to create an auto-sync-permissions connector", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Admin Auto-sync",
          connectorType: "github",
          visibility: "auto-sync-permissions",
          teamIds: [],
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "pat",
          },
          credentials: { apiToken: "ghp_token" },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().visibility).toBe("auto-sync-permissions");
    });

    test("creates a perforce connector and normalizes depot paths", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Docs Depot",
          connectorType: "perforce",
          config: {
            type: "perforce",
            serverUrl: "https://perforce.example.com:8080",
            depotPaths: ["//depot/docs/...", "//stream/main/specs/"],
            fileTypes: [".md", ".yaml"],
          },
          credentials: {
            email: "svc-knowledge",
            apiToken: "perforce-ticket",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const connector = response.json();
      expect(connector.connectorType).toBe("perforce");
      expect(connector.config).toMatchObject({
        type: "perforce",
        serverUrl: "https://perforce.example.com:8080",
        depotPaths: ["//depot/docs", "//stream/main/specs"],
      });

      const stored = await KnowledgeBaseConnectorModel.findById(connector.id);
      expect(stored?.config).toMatchObject({
        depotPaths: ["//depot/docs", "//stream/main/specs"],
      });
    });

    test("persists an explicit permission-sync interval and defaults it otherwise", async () => {
      const withInterval = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Interval Depot",
          connectorType: "perforce",
          config: {
            type: "perforce",
            serverUrl: "https://perforce.example.com:8080",
            depotPaths: ["//depot/docs"],
          },
          credentials: { email: "svc-knowledge", apiToken: "ticket" },
          permissionSyncIntervalSeconds: 6 * 60 * 60,
        },
      });
      expect(withInterval.statusCode).toBe(200);
      expect(withInterval.json().permissionSyncIntervalSeconds).toBe(
        6 * 60 * 60,
      );

      const withoutInterval = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Default Interval Depot",
          connectorType: "perforce",
          config: {
            type: "perforce",
            serverUrl: "https://perforce.example.com:8080",
            depotPaths: ["//depot/specs"],
          },
          credentials: { email: "svc-knowledge", apiToken: "ticket" },
        },
      });
      expect(withoutInterval.statusCode).toBe(200);
      expect(withoutInterval.json().permissionSyncIntervalSeconds).toBe(
        30 * 60,
      );
    });

    test("rejects a permission-sync interval below the 15-minute floor", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Too Frequent",
          connectorType: "perforce",
          config: {
            type: "perforce",
            serverUrl: "https://perforce.example.com:8080",
            depotPaths: ["//depot/docs"],
          },
          credentials: { email: "svc-knowledge", apiToken: "ticket" },
          permissionSyncIntervalSeconds: 60,
        },
      });
      expect(response.statusCode).toBe(400);
    });

    test("accepts interval 0 — follow the documents sync schedule", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Follows Documents Schedule",
          connectorType: "perforce",
          config: {
            type: "perforce",
            serverUrl: "https://perforce.example.com:8080",
            depotPaths: ["//depot/docs"],
          },
          credentials: { email: "svc-knowledge", apiToken: "ticket" },
          permissionSyncIntervalSeconds:
            PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().permissionSyncIntervalSeconds).toBe(
        PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
      );
    });

    test("rejects perforce depot paths containing revision metacharacters", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Bad Depot",
          connectorType: "perforce",
          config: {
            type: "perforce",
            serverUrl: "https://perforce.example.com:8080",
            depotPaths: ["//depot/docs@123"],
          },
          credentials: {
            email: "svc-knowledge",
            apiToken: "perforce-ticket",
          },
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/connectors", () => {
    test("hides auto-sync-permissions connectors from non-admin members", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeMember,
    }) => {
      await makeMember(user.id, organizationId);
      const kb = await makeKnowledgeBase(organizationId);
      const autoSync = await makeKnowledgeBaseConnector(kb.id, organizationId, {
        connectorType: "github",
        visibility: "auto-sync-permissions",
      });
      const orgWide = await makeKnowledgeBaseConnector(kb.id, organizationId);

      const list = await app.inject({
        method: "GET",
        url: "/api/connectors?limit=50&offset=0",
      });
      expect(list.statusCode).toBe(200);
      const listedIds = list.json().data.map((c: { id: string }) => c.id);
      expect(listedIds).toContain(orgWide.id);
      expect(listedIds).not.toContain(autoSync.id);

      // The detail surfaces must read as "not found", not just be filtered
      // from lists.
      const detail = await app.inject({
        method: "GET",
        url: `/api/connectors/${autoSync.id}`,
      });
      expect(detail.statusCode).toBe(404);
      const documents = await app.inject({
        method: "GET",
        url: `/api/connectors/${autoSync.id}/documents`,
      });
      expect(documents.statusCode).toBe(404);
      const update = await app.inject({
        method: "PUT",
        url: `/api/connectors/${autoSync.id}`,
        payload: { name: "renamed" },
      });
      expect(update.statusCode).toBe(404);
    });

    test("shows auto-sync-permissions connectors to knowledgeSource admins", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const kb = await makeKnowledgeBase(organizationId);
      const autoSync = await makeKnowledgeBaseConnector(kb.id, organizationId, {
        connectorType: "github",
        visibility: "auto-sync-permissions",
      });

      const list = await app.inject({
        method: "GET",
        url: "/api/connectors?limit=50&offset=0",
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((c: { id: string }) => c.id)).toContain(
        autoSync.id,
      );

      const detail = await app.inject({
        method: "GET",
        url: `/api/connectors/${autoSync.id}`,
      });
      expect(detail.statusCode).toBe(200);
    });

    test("lists connectors for the organization", async () => {
      await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Conn A",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://a.atlassian.net",
          isCloud: true,
          projectKey: "A",
        },
      });
      await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Conn B",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://b.atlassian.net",
          isCloud: true,
          projectKey: "B",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/connectors?limit=50&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);

      const names = body.data.map((c: { name: string }) => c.name);
      expect(names).toContain("Conn A");
      expect(names).toContain("Conn B");
    });

    test("filters connectors by knowledge base ID", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Filter KB",
      });
      const assignedConn = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Assigned Conn",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://assigned.atlassian.net",
          isCloud: true,
          projectKey: "ASS",
        },
      });
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        assignedConn.id,
        kb.id,
      );
      await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Unassigned Conn",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://unassigned.atlassian.net",
          isCloud: true,
          projectKey: "UNA",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors?knowledgeBaseId=${kb.id}&limit=50&offset=0`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.data.map((c: { name: string }) => c.name);
      expect(names).toContain("Assigned Conn");
      expect(names).not.toContain("Unassigned Conn");
    });
  });

  describe("PUT /api/connectors/:id", () => {
    test("preserves the stored username when rotating only the token", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Rotate Connector",
        connectorType: "perforce",
        config: {
          type: "perforce",
          serverUrl: "https://perforce.example.com:8080",
          depotPaths: ["//depot/docs"],
        },
      });
      const secret = await secretManager().createSecret(
        { email: "svc-knowledge", apiToken: "old-ticket" },
        "connector-rotate",
      );
      await KnowledgeBaseConnectorModel.update(connector.id, {
        secretId: secret.id,
      });

      // The edit dialog omits the email field when left blank.
      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          name: "Rotate Connector",
          credentials: { apiToken: "new-ticket" },
        },
      });

      expect(response.statusCode).toBe(200);
      const updatedSecret = await secretManager().getSecret(secret.id);
      expect(updatedSecret?.secret).toMatchObject({
        email: "svc-knowledge",
        apiToken: "new-ticket",
      });
    });

    test("adds an admin API key without re-entering the API token", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Admin Key Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });
      const secret = await secretManager().createSecret(
        { email: "user@example.com", apiToken: "user-token" },
        "connector-admin-key",
      );
      await KnowledgeBaseConnectorModel.update(connector.id, {
        secretId: secret.id,
      });

      // The edit dialog sends only the fields the admin typed — here just
      // the new admin API key, with the token field left blank.
      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          credentials: { adminApiKey: "org-admin-key" },
        },
      });

      expect(response.statusCode).toBe(200);
      const updatedSecret = await secretManager().getSecret(secret.id);
      expect(updatedSecret?.secret).toMatchObject({
        email: "user@example.com",
        apiToken: "user-token",
        adminApiKey: "org-admin-key",
      });
    });

    test("updates a connector name and schedule", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Original Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          name: "Updated Connector",
          enabled: false,
          schedule: "0 0 * * *",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(connector.id);
      expect(body.name).toBe("Updated Connector");
      expect(body.enabled).toBe(false);
      expect(body.schedule).toBe("0 0 * * *");
    });

    test("updates the permission-sync interval", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Interval Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { permissionSyncIntervalSeconds: 60 * 60 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().permissionSyncIntervalSeconds).toBe(60 * 60);

      const belowFloor = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { permissionSyncIntervalSeconds: 60 },
      });
      expect(belowFloor.statusCode).toBe(400);

      // An effectively-infinite interval would silently disable the
      // scheduled pass; follow-documents mode is the way to opt out.
      const aboveCeiling = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { permissionSyncIntervalSeconds: 30 * 24 * 60 * 60 },
      });
      expect(aboveCeiling.statusCode).toBe(400);
    });

    test("switching a connector to auto-sync-permissions enqueues an immediate deduped permission sync", async ({
      makeMember,
    }) => {
      // Switching into auto-sync (and touching the connector afterwards)
      // requires the knowledgeSourceAutoSync permission (admin role here).
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Switch Connector",
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "test-org",
          authMethod: "pat",
        },
        visibility: "org-wide",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { visibility: "auto-sync-permissions" },
      });
      expect(response.statusCode).toBe(200);
      expect(
        await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
      ).toBe(true);

      // A second no-op-ish update (visibility unchanged) must not enqueue more.
      const again = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { visibility: "auto-sync-permissions", teamIds: ["team-x"] },
      });
      expect(again.statusCode).toBe(200);
      const { rows } = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM tasks
        WHERE task_type = 'permission_sync'
          AND payload->>'connectorId' = ${connector.id}
      `);
      expect(rows[0]?.count).toBe(1);
    });

    test("rejects switching to auto-sync-permissions for a member without the dedicated permission", async ({
      makeMember,
    }) => {
      // Default member role: knowledgeSource update, but no
      // knowledgeSourceAutoSync grants.
      await makeMember(user.id, organizationId);
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Member Switch Connector",
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "test-org",
          authMethod: "pat",
        },
        visibility: "org-wide",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { visibility: "auto-sync-permissions" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain(
        '"update" permission for auto-sync-permissions connectors',
      );
    });

    test("persists connector updates across reads", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Persist Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { name: "Persisted Name" },
      });

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}`,
      });

      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json().name).toBe("Persisted Name");
    });

    test("switching a GitHub App connector to PAT creates an inline secret", async () => {
      const appSecret = await secretManager().createSecret(
        { apiToken: "-----BEGIN PRIVATE KEY-----" },
        "app",
      );
      const appConfig = await GithubAppConfigModel.create({
        organizationId,
        name: "App",
        appId: "1",
        installationId: "1",
        secretId: appSecret.id,
      });
      // App connectors hold no inline secret — credentials live in the config row
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "App Connector",
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "test-org",
          authMethod: "github_app",
          githubAppConfigId: appConfig.id,
        },
        secretId: null,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "pat",
          },
          credentials: { apiToken: "ghp_token" },
        },
      });

      expect(response.statusCode).toBe(200);
      const newSecretId = response.json().secretId;
      expect(newSecretId).toBeTruthy();
      const secret = await secretManager().getSecret(newSecretId);
      expect((secret?.secret as { apiToken?: string })?.apiToken).toBe(
        "ghp_token",
      );
    });

    test("rejects inline credentials on a GitHub App connector update", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const appConfig = await GithubAppConfigModel.create({
        organizationId,
        name: "App",
        appId: "1",
        installationId: "1",
      });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "App Connector",
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "test-org",
          authMethod: "github_app",
          githubAppConfigId: appConfig.id,
        },
        secretId: null,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { credentials: { apiToken: "ghp_token" } },
      });

      expect(response.statusCode).toBe(400);
    });

    test("switching a GitHub App connector to PAT without credentials is rejected", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const appConfig = await GithubAppConfigModel.create({
        organizationId,
        name: "App",
        appId: "1",
        installationId: "1",
      });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "App Connector",
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "test-org",
          authMethod: "github_app",
          githubAppConfigId: appConfig.id,
        },
        secretId: null,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "pat",
          },
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("a rejected App switch does not drop the connector's existing secret", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const appConfig = await GithubAppConfigModel.create({
        organizationId,
        name: "App",
        appId: "1",
        installationId: "1",
      });
      const secret = await secretManager().createSecret(
        { apiToken: "ghp_existing" },
        "pat-connector",
      );
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "PAT Connector",
        connectorType: "github",
        visibility: "org-wide",
        teamIds: [],
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "test-org",
          authMethod: "pat",
        },
        secretId: secret.id,
      });

      // switch to App auth while tripping the team-scoped validation; the
      // request must fail without having deleted the original secret first
      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          visibility: "team-scoped",
          teamIds: [],
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "github_app",
            githubAppConfigId: appConfig.id,
          },
        },
      });

      expect(response.statusCode).toBe(400);
      const stored = await KnowledgeBaseConnectorModel.findById(connector.id);
      expect(stored?.secretId).toBe(secret.id);
      expect(await secretManager().getSecret(secret.id)).not.toBeNull();
    });

    test("a GitHub App connector adopts the App config's host", async ({
      makeMember,
    }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const appConfig = await GithubAppConfigModel.create({
        organizationId,
        name: "GHES App",
        githubUrl: "https://ghe.example.com/api/v3",
        appId: "1",
        installationId: "1",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "GHES Connector",
          visibility: "org-wide",
          teamIds: [],
          connectorType: "github",
          // the form may leave the default github.com host; the saved connector
          // must inherit the App config's host so the minted token matches
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "github_app",
            githubAppConfigId: appConfig.id,
          },
          schedule: "0 */6 * * *",
          enabled: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().config.githubUrl).toBe(
        "https://ghe.example.com/api/v3",
      );
    });

    test("creating a GitHub App connector requires githubAppConfig:read", async () => {
      // the default test user has no githubAppConfig permission
      const appConfig = await GithubAppConfigModel.create({
        organizationId,
        name: "App",
        appId: "1",
        installationId: "1",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "App Connector",
          visibility: "org-wide",
          teamIds: [],
          connectorType: "github",
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "github_app",
            githubAppConfigId: appConfig.id,
          },
          schedule: "0 */6 * * *",
          enabled: true,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    test("rejects a malformed githubAppConfigId before it reaches the database", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "App Connector",
          visibility: "org-wide",
          teamIds: [],
          connectorType: "github",
          config: {
            type: "github",
            githubUrl: "https://api.github.com",
            owner: "test-org",
            authMethod: "github_app",
            githubAppConfigId: "not-a-uuid",
          },
          schedule: "0 */6 * * *",
          enabled: true,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("does not refresh ACLs when visibility inputs are unchanged", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "No ACL Refresh Connector",
        connectorType: "jira",
        visibility: "org-wide",
        teamIds: [],
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const refreshSpy = vi.spyOn(
        knowledgeSourceAccessControlService,
        "refreshConnectorDocumentAccessControlLists",
      );

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          visibility: "org-wide",
          teamIds: [],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    test("returns 404 for non-existent connector", async () => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${crypto.randomUUID()}`,
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(404);
    });

    test("rejects team-scoped updates without teamIds", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Invalid Update Connector",
        connectorType: "jira",
        visibility: "org-wide",
        teamIds: [],
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          visibility: "team-scoped",
          teamIds: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "At least one team must be selected for team-scoped connectors",
      );
    });

    test("rejects changing visibility to team-scoped without enterprise license", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Org-Wide Connector",
        connectorType: "jira",
        visibility: "org-wide",
        teamIds: [],
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const original = config.enterpriseFeatures.knowledgeBase;
      Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
        value: false,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(9999);
      try {
        const response = await app.inject({
          method: "PUT",
          url: `/api/connectors/${connector.id}`,
          payload: {
            visibility: "team-scoped",
            teamIds: [crypto.randomUUID()],
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.message).toContain(
          "Team-scoped connectors require an enterprise license",
        );
      } finally {
        Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
          value: original,
          writable: true,
          configurable: true,
        });
        enterpriseTier.setUserCountForTesting(0);
      }
    });

    test("allows updating existing team-scoped connector without enterprise license", async ({
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, user.id, {
        name: "Scoped Team",
      });
      await makeTeamMember(team.id, user.id);
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Team Connector",
        connectorType: "jira",
        visibility: "team-scoped",
        teamIds: [team.id],
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const original = config.enterpriseFeatures.knowledgeBase;
      Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
        value: false,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(9999);
      try {
        const response = await app.inject({
          method: "PUT",
          url: `/api/connectors/${connector.id}`,
          payload: {
            name: "Renamed Connector",
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().name).toBe("Renamed Connector");
      } finally {
        Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
          value: original,
          writable: true,
          configurable: true,
        });
        enterpriseTier.setUserCountForTesting(0);
      }
    });
  });

  describe("DELETE /api/connectors/:id", () => {
    test("deletes a connector", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "To Delete Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    test("returns 404 on re-fetch after connector deletion", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Delete Then Fetch Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}`,
      });

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}`,
      });

      expect(getResponse.statusCode).toBe(404);
    });

    test("returns 404 for non-existent connector", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("purges the connector's queued tasks, leaving other connectors' tasks", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Queued Work Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });
      const other = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Survivor Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://survivor.atlassian.net",
          isCloud: true,
          projectKey: "SURV",
        },
      });

      // A content-sync run whose batch_embedding tasks reference it by run id
      // (batch_embedding payloads carry connectorRunId, not connectorId).
      const run = await ConnectorRunModel.create({
        connectorId: connector.id,
        status: "running",
        startedAt: new Date(),
      });
      await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: connector.id },
      });
      await TaskModel.create({
        taskType: "batch_embedding",
        payload: { connectorRunId: run.id, documentIds: ["doc-1"] },
      });
      // The survivor's queued sync must be untouched.
      await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: other.id },
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}`,
      });
      expect(response.statusCode).toBe(200);

      expect(
        await TaskModel.hasPendingOrProcessing("connector_sync", connector.id),
      ).toBe(false);
      expect(
        await TaskModel.hasPendingOrProcessingByType("batch_embedding"),
      ).toBe(false);
      // The survivor's task is still queued.
      expect(
        await TaskModel.hasPendingOrProcessing("connector_sync", other.id),
      ).toBe(true);
    });
  });

  // ===== Connector Knowledge Base Assignments =====

  describe("GET /api/connectors/:id/knowledge-bases", () => {
    test("lists knowledge bases assigned to a connector", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Assigned KB",
      });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Assigned Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/knowledge-bases`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(kb.id);
      expect(body.data[0].name).toBe("Assigned KB");
    });

    test("returns empty list when connector has no assignments", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Lonely Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/knowledge-bases`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });
  });

  describe("POST /api/connectors/:id/knowledge-bases", () => {
    test("assigns a connector to knowledge bases", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Target KB",
      });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Assignable Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${connector.id}/knowledge-bases`,
        payload: { knowledgeBaseIds: [kb.id] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);

      // Verify assignment via GET
      const listResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/knowledge-bases`,
      });
      expect(listResponse.json().data).toHaveLength(1);
      expect(listResponse.json().data[0].id).toBe(kb.id);
    });
  });

  describe("DELETE /api/connectors/:id/knowledge-bases/:kbId", () => {
    test("unassigns a connector from a knowledge base", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Unassign KB",
      });
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Unassign Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      );

      const response = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}/knowledge-bases/${kb.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);

      // Verify unassignment
      const listResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/knowledge-bases`,
      });
      expect(listResponse.json().data).toEqual([]);
    });
  });

  // ===== Connector Runs =====

  describe("GET /api/connectors/:id/runs", () => {
    test("lists connector runs (empty initially)", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Runs Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination.total).toBe(0);
    });

    test("lists connector runs with data", async ({
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Runs KB",
      });
      const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
      await makeConnectorRun(connector.id, { status: "success" });
      await makeConnectorRun(connector.id, { status: "failed" });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.length).toBe(2);
      expect(body.pagination.total).toBe(2);
    });

    test("flags a queued sync while its task is unclaimed, and clears it once a run is running", async ({
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Queued Runs KB",
      });
      const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);

      // Enqueued but unclaimed: no run row exists yet — the endpoint must
      // surface the gap so the UI can render a synthetic Queued row instead
      // of showing nothing.
      await TaskModel.create({
        taskType: "connector_sync",
        payload: { connectorId: connector.id },
      });
      let response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().queued).toEqual({
        content: true,
        permission: false,
      });

      // Claimed: the task stays pending/processing for the whole run, so a
      // running run row must flip the flag back off.
      await makeConnectorRun(connector.id, { status: "running" });
      response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0`,
      });
      expect(response.json().queued).toEqual({
        content: false,
        permission: false,
      });
    });

    test("filters connector runs by status", async ({
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Runs Status KB",
      });
      const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
      await makeConnectorRun(connector.id, { status: "success" });
      await makeConnectorRun(connector.id, { status: "failed" });
      await makeConnectorRun(connector.id, { status: "failed" });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0&status=failed`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ status: string }>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(2);
      expect(body.data.every((run) => run.status === "failed")).toBe(true);
    });

    test("filters connector runs by result across both run families", async ({
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Runs Result KB",
      });
      const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
      // Documents run that ingested nothing vs one that ingested.
      await makeConnectorRun(connector.id, {
        runType: "content",
        documentsIngested: 0,
      });
      await makeConnectorRun(connector.id, {
        runType: "content",
        documentsIngested: 5,
      });
      // Clean delta pass vs a pass that updated permissions.
      await makeConnectorRun(connector.id, {
        runType: "permission",
        stats: {
          mode: "delta",
          totalDocs: 10,
          docsScanned: 10,
          aclsChanged: 0,
          chunksRewritten: 0,
          failClosed: 0,
          groupsSynced: 2,
          membershipsUpserted: 0,
          contentSyncActiveDuringRun: false,
        },
      });
      await makeConnectorRun(connector.id, {
        runType: "permission",
        stats: {
          mode: "delta",
          totalDocs: 10,
          docsScanned: 10,
          aclsChanged: 3,
          chunksRewritten: 3,
          failClosed: 0,
          groupsSynced: 2,
          membershipsUpserted: 0,
          contentSyncActiveDuringRun: false,
        },
      });

      const withChanges = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0&result=changes`,
      });
      expect(withChanges.statusCode).toBe(200);
      expect(withChanges.json().pagination.total).toBe(2);

      const noChanges = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs?limit=10&offset=0&result=no-changes`,
      });
      expect(noChanges.statusCode).toBe(200);
      expect(noChanges.json().pagination.total).toBe(2);
    });

    test("returns 404 for runs of non-existent connector", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${crypto.randomUUID()}/runs?limit=10&offset=0`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/connectors/:id/runs/:runId", () => {
    test("gets a single connector run", async ({
      makeKnowledgeBaseConnector,
      makeConnectorRun,
    }) => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Single Run KB",
      });
      const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
      const run = await makeConnectorRun(connector.id, {
        status: "success",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs/${run.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(run.id);
      expect(body.connectorId).toBe(connector.id);
      expect(body.status).toBe("success");
    });

    test("returns 404 for non-existent run", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "No Run Connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/runs/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ===== Cross-Entity Behavior =====

  test("deleting a knowledge base removes its connector assignments without deleting the connector", async () => {
    const knowledgeBase = await KnowledgeBaseModel.create({
      organizationId,
      name: "Route Test KB",
    });
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "Route Test Connector",
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://test.atlassian.net",
        isCloud: true,
        projectKey: "PROJ",
      },
    });
    await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
      connector.id,
      knowledgeBase.id,
    );

    const beforeDeleteResponse = await app.inject({
      method: "GET",
      url: `/api/connectors/${connector.id}/knowledge-bases`,
    });

    expect(beforeDeleteResponse.statusCode).toBe(200);
    expect(beforeDeleteResponse.json()).toEqual({
      data: [
        expect.objectContaining({
          id: knowledgeBase.id,
          name: "Route Test KB",
        }),
      ],
    });

    await KnowledgeBaseModel.delete(knowledgeBase.id);
    expect(await KnowledgeBaseModel.findById(knowledgeBase.id)).toBeNull();

    const connectorResponse = await app.inject({
      method: "GET",
      url: `/api/connectors/${connector.id}`,
    });

    expect(connectorResponse.statusCode).toBe(200);
    expect(connectorResponse.json()).toMatchObject({
      id: connector.id,
      name: "Route Test Connector",
    });

    const connectorKnowledgeBasesResponse = await app.inject({
      method: "GET",
      url: `/api/connectors/${connector.id}/knowledge-bases`,
    });

    expect(connectorKnowledgeBasesResponse.statusCode).toBe(200);
    expect(connectorKnowledgeBasesResponse.json()).toEqual({ data: [] });
  });

  // ===== Health Check =====

  describe("GET /api/knowledge-bases/:id/health", () => {
    test("returns healthy status for existing knowledge base", async () => {
      const kb = await KnowledgeBaseModel.create({
        organizationId,
        name: "Health Check KB",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${kb.id}/health`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("healthy");
    });

    test("returns 404 for non-existent knowledge base", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases/${crypto.randomUUID()}/health`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/connectors/:id/permission-sync", () => {
    // Auto-sync connector surfaces need the knowledgeSourceAutoSync
    // permission (admin role here); everyone else gets 404/403.
    beforeEach(async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    });

    test("enqueues a permission_sync task for an auto-sync github connector", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "auto-sync-permissions",
        },
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${connector.id}/permission-sync`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("enqueued");
      expect(
        await TaskModel.hasPendingOrProcessing("permission_sync", connector.id),
      ).toBe(true);
    });

    test("rejects a non-auto-sync connector with 400", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "org-wide",
        },
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${connector.id}/permission-sync`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "auto-sync-permissions connectors",
      );
    });

    test("rejects a connector type that does not support permission sync", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      // notion is not a permission-sync connector, but a stored row can still
      // carry the auto-sync visibility; the trigger must reject it.
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "notion",
          visibility: "auto-sync-permissions",
        },
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${connector.id}/permission-sync`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("not supported");
    });
  });

  describe("GET /api/connectors/:id/permission-coverage", () => {
    beforeEach(async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    });

    test("reports total vs fail-closed documents for an auto-sync connector", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "auto-sync-permissions",
        },
      );
      // One tagged doc + one still fail-closed (awaiting a pass).
      await KbDocumentModel.create({
        organizationId,
        sourceId: "tagged",
        connectorId: connector.id,
        title: "t",
        content: "c",
        contentHash: "h1",
        acl: ["user_email:alice@example.com"],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "pending",
        connectorId: connector.id,
        title: "t",
        content: "c",
        contentHash: "h2",
        acl: [],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/permission-coverage`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.totalDocuments).toBe(2);
      expect(body.failClosedDocuments).toBe(1);
      expect(body.permissionSyncRunning).toBe(false);
      // Effective global schedule always yields a next run in tests.
      expect(typeof body.nextScheduledAt).toBe("string");
    });

    test("flags a running permission sync", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "auto-sync-permissions",
        },
      );
      await ConnectorRunModel.claim({
        connectorId: connector.id,
        owner: "w",
        leaseTtlSeconds: 300,
        runType: "permission",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/permission-coverage`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().permissionSyncRunning).toBe(true);
    });

    test("flags a queued permission sync before the worker claims a run", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "auto-sync-permissions",
        },
      );
      // A manual trigger enqueues a task; the run row appears only when the
      // worker claims it. The gap must still read as "running" in the UI.
      await TaskModel.create({
        taskType: "permission_sync",
        payload: { connectorId: connector.id },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/permission-coverage`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().permissionSyncRunning).toBe(true);
    });

    test("rejects a non-auto-sync connector with 400", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "github", visibility: "org-wide" },
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/permission-coverage`,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/connectors/:id/user-groups", () => {
    beforeEach(async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    });

    test("aggregates the membership snapshot and resolves members to org users", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeMember,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "auto-sync-permissions",
        },
      );

      // alice is an org member (resolves); bob has no account (resolves to
      // nobody); dave's email is hidden upstream (recorded, fail-closed).
      const alice = await makeUser({ email: "Alice@Example.com" });
      await makeMember(alice.id, organizationId);
      await KbExternalUserGroupModel.upsertMany([
        {
          organizationId,
          connectorId: connector.id,
          connectorType: "github",
          groupId: "engineers",
          externalAccountId: "alice",
          displayName: "Alice A",
          memberEmail: "alice@example.com",
        },
        {
          organizationId,
          connectorId: connector.id,
          connectorType: "github",
          groupId: "engineers",
          externalAccountId: "bob",
          displayName: "Bob B",
          memberEmail: "bob@example.com",
        },
        {
          organizationId,
          connectorId: connector.id,
          connectorType: "github",
          groupId: "engineers",
          externalAccountId: "dave",
          displayName: "Dave D",
          memberEmail: null,
        },
      ]);
      // Two docs grant the group, one grants only an unknown group.
      await KbDocumentModel.create({
        organizationId,
        sourceId: "d1",
        connectorId: connector.id,
        title: "t",
        content: "c",
        contentHash: "h1",
        acl: ["group:github_engineers"],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "d2",
        connectorId: connector.id,
        title: "t",
        content: "c",
        contentHash: "h2",
        acl: ["group:github_engineers", "user_email:alice@example.com"],
      });
      await KbDocumentModel.create({
        organizationId,
        sourceId: "d3",
        connectorId: connector.id,
        title: "t",
        content: "c",
        contentHash: "h3",
        acl: ["group:github_ghosts"],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/user-groups`,
      });

      expect(response.statusCode).toBe(200);
      const { groups } = response.json();
      expect(groups).toHaveLength(2);

      const engineers = groups.find(
        (g: { groupId: string }) => g.groupId === "engineers",
      );
      expect(engineers.token).toBe("group:github_engineers");
      expect(engineers.documentCount).toBe(2);
      expect(engineers.lastSyncedAt).toEqual(expect.any(String));
      expect(engineers.members).toEqual([
        {
          accountId: "alice",
          displayName: "Alice A",
          email: "alice@example.com",
          accountType: null,
          user: { id: alice.id, name: alice.name },
          resolvedVia: "email",
        },
        {
          accountId: "bob",
          displayName: "Bob B",
          email: "bob@example.com",
          accountType: null,
          user: null,
          resolvedVia: null,
        },
        // Hidden email: recorded and visible to admins, resolves to nobody.
        {
          accountId: "dave",
          displayName: "Dave D",
          email: null,
          accountType: null,
          user: null,
          resolvedVia: null,
        },
      ]);

      // Granted on a document but absent from the snapshot: visible, no members.
      const ghosts = groups.find(
        (g: { groupId: string }) => g.groupId === "ghosts",
      );
      expect(ghosts).toEqual({
        groupId: "ghosts",
        token: "group:github_ghosts",
        documentCount: 1,
        lastSyncedAt: null,
        members: [],
      });
    });

    test("does not resolve a user from another organization's membership", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          connectorType: "github",
          visibility: "auto-sync-permissions",
        },
      );
      // carol exists but is a member of a DIFFERENT org — must not resolve.
      const carol = await makeUser({ email: "carol@example.com" });
      const otherOrg = await makeOrganization();
      await makeMember(carol.id, otherOrg.id);
      await KbExternalUserGroupModel.upsertMany([
        {
          organizationId,
          connectorId: connector.id,
          connectorType: "github",
          groupId: "engineers",
          externalAccountId: "carol@example.com",
          memberEmail: "carol@example.com",
        },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/user-groups`,
      });

      expect(response.statusCode).toBe(200);
      const { groups } = response.json();
      expect(groups[0].members).toEqual([
        {
          accountId: "carol@example.com",
          displayName: null,
          email: "carol@example.com",
          accountType: null,
          user: null,
          resolvedVia: null,
        },
      ]);
    });

    test("rejects a non-auto-sync connector with 400", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "github", visibility: "org-wide" },
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/user-groups`,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("PUT/DELETE /api/connectors/:id/member-overrides", () => {
    beforeEach(async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    });

    /** Auto-sync connector with one hidden-email membership. */
    async function makeConnectorWithHiddenMember(fixtures: {
      makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
      makeKnowledgeBaseConnector: (
        kbId: string,
        orgId: string,
        overrides: Record<string, unknown>,
      ) => Promise<{ id: string }>;
    }) {
      const kb = await fixtures.makeKnowledgeBase(organizationId);
      const connector = await fixtures.makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "jira", visibility: "auto-sync-permissions" },
      );
      await KbExternalUserGroupModel.upsertMany([
        {
          organizationId,
          connectorId: connector.id,
          connectorType: "jira",
          groupId: "eng",
          externalAccountId: "acc-hidden",
          displayName: "Hidden H",
          memberEmail: null,
        },
      ]);
      return connector;
    }

    test("maps a hidden-email member to an org user; user-groups reports it as an override", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeMember,
    }) => {
      const connector = await makeConnectorWithHiddenMember({
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const alice = await makeUser({ email: "alice@example.com" });
      await makeMember(alice.id, organizationId);

      const putResponse = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-hidden", userId: alice.id },
      });
      expect(putResponse.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/user-groups`,
      });
      expect(response.json().groups[0].members).toEqual([
        {
          accountId: "acc-hidden",
          displayName: "Hidden H",
          email: null,
          accountType: null,
          user: { id: alice.id, name: alice.name },
          resolvedVia: "override",
        },
      ]);
    });

    test("automatic email matching takes precedence over an override", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeMember,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "jira", visibility: "auto-sync-permissions" },
      );
      const alice = await makeUser({ email: "alice@example.com" });
      await makeMember(alice.id, organizationId);
      const bob = await makeUser({ email: "bob@example.com" });
      await makeMember(bob.id, organizationId);
      // Membership matches alice by email; an admin override pointing at bob
      // is inert while the automatic match holds (by definition of
      // auto-sync permissions — the source's identity wins).
      await KbExternalUserGroupModel.upsertMany([
        {
          organizationId,
          connectorId: connector.id,
          connectorType: "jira",
          groupId: "eng",
          externalAccountId: "acc-1",
          memberEmail: "alice@example.com",
        },
      ]);
      await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-1", userId: bob.id },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/user-groups`,
      });
      expect(response.json().groups[0].members[0]).toMatchObject({
        user: { id: alice.id, name: alice.name },
        resolvedVia: "email",
      });
    });

    test("rejects mapping to a user outside the organization with 404", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
    }) => {
      const connector = await makeConnectorWithHiddenMember({
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      // Exists as a user, but is not a member of this org.
      const outsider = await makeUser({ email: "outsider@example.com" });

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-hidden", userId: outsider.id },
      });
      expect(response.statusCode).toBe(404);
    });

    test("rejects a non-auto-sync connector with 400", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeMember,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "jira", visibility: "org-wide" },
      );
      const alice = await makeUser({ email: "alice@example.com" });
      await makeMember(alice.id, organizationId);

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-1", userId: alice.id },
      });
      expect(response.statusCode).toBe(400);
    });

    test("deleting a mapping falls back to email resolution (nobody for a hidden email)", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeMember,
    }) => {
      const connector = await makeConnectorWithHiddenMember({
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const alice = await makeUser({ email: "alice@example.com" });
      await makeMember(alice.id, organizationId);
      await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-hidden", userId: alice.id },
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}/member-overrides/acc-hidden`,
      });
      expect(deleteResponse.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}/user-groups`,
      });
      expect(response.json().groups[0].members[0]).toMatchObject({
        user: null,
        resolvedVia: null,
      });

      // Deleting again: nothing to remove.
      const repeat = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}/member-overrides/acc-hidden`,
      });
      expect(repeat.statusCode).toBe(404);
    });

    test("saving and removing a mapping each enqueue a forced audience-refresh pass", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeUser,
      makeMember,
    }) => {
      const connector = await makeConnectorWithHiddenMember({
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      const alice = await makeUser({ email: "alice@example.com" });
      await makeMember(alice.id, organizationId);

      const refreshTasks = async () =>
        (
          await db.execute<{ payload: Record<string, unknown> }>(sql`
            SELECT payload FROM tasks
            WHERE task_type = 'permission_sync'
              AND payload->>'connectorId' = ${connector.id}
              AND payload->>'refreshAudiences' = 'true'
          `)
        ).rows;

      const putResponse = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-hidden", userId: alice.id },
      });
      expect(putResponse.statusCode).toBe(200);
      // A DIRECT grant to the mapped account only materializes when container
      // audiences are re-resolved — the save must schedule that itself.
      expect(await refreshTasks()).toHaveLength(1);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${connector.id}/member-overrides/acc-hidden`,
      });
      expect(deleteResponse.statusCode).toBe(200);
      expect(await refreshTasks()).toHaveLength(2);
    });
  });

  describe("auto-sync permissions beta gate", () => {
    beforeEach(async ({ makeMember }) => {
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    });

    test("selecting the visibility and the permission-family routes are rejected when the flag is off", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      // Pre-existing auto-sync connector (e.g. created while the beta was on).
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "jira", visibility: "auto-sync-permissions" },
      );
      config.kb.autoSyncPermissionsEnabled = false;

      const create = await app.inject({
        method: "POST",
        url: "/api/connectors",
        payload: {
          name: "Auto-sync Connector",
          connectorType: "jira",
          visibility: "auto-sync-permissions",
          teamIds: [],
          config: {
            type: "jira",
            jiraBaseUrl: "https://test.atlassian.net",
            isCloud: true,
            projectKey: "TEST",
          },
          credentials: { email: "user@example.com", apiToken: "token" },
        },
      });
      expect(create.statusCode).toBe(403);
      expect(create.json().error.message).toContain("beta feature");

      for (const [method, url] of [
        ["POST", `/api/connectors/${connector.id}/permission-sync`],
        ["GET", `/api/connectors/${connector.id}/permission-coverage`],
        ["GET", `/api/connectors/${connector.id}/user-groups`],
        ["DELETE", `/api/connectors/${connector.id}/member-overrides/acc-1`],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
      const upsert = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}/member-overrides`,
        payload: { externalAccountId: "acc-1", userId: user.id },
      });
      expect(upsert.statusCode).toBe(403);
    });

    test("an existing auto-sync connector still reads and updates normally with the flag off", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        { connectorType: "jira", visibility: "auto-sync-permissions" },
      );
      config.kb.autoSyncPermissionsEnabled = false;

      const get = await app.inject({
        method: "GET",
        url: `/api/connectors/${connector.id}`,
      });
      expect(get.statusCode).toBe(200);

      // Updating without switching INTO auto-sync stays allowed (including
      // switching away from it).
      const update = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: { name: "renamed" },
      });
      expect(update.statusCode).toBe(200);
    });
  });
});

// ===== RBAC Permission Configuration =====
// Verify that the permission map correctly restricts member access to read-only.
// This is the declarative layer that the auth middleware enforces at runtime.

describe("knowledge base permission configuration", () => {
  test("member permissions only allow read and query for knowledgeSource", async () => {
    const { memberPermissions } = await import(
      "@archestra/shared/access-control"
    );
    expect(memberPermissions.knowledgeSource).toEqual(["read", "query"]);
    expect(memberPermissions.knowledgeSource).not.toContain("create");
    expect(memberPermissions.knowledgeSource).not.toContain("update");
    expect(memberPermissions.knowledgeSource).not.toContain("delete");
  });

  test("admin permissions include full CRUD for knowledgeSource", async () => {
    const { adminPermissions } = await import(
      "@archestra/shared/access-control"
    );
    expect(adminPermissions.knowledgeSource).toContain("read");
    expect(adminPermissions.knowledgeSource).toContain("create");
    expect(adminPermissions.knowledgeSource).toContain("update");
    expect(adminPermissions.knowledgeSource).toContain("delete");
    expect(adminPermissions.knowledgeSource).toContain("query");
  });

  test("knowledge base routes require correct permissions", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    const { RouteId } = await import("@archestra/shared");

    // Read routes require knowledgeSource:read
    expect(requiredEndpointPermissionsMap[RouteId.GetKnowledgeBases]).toEqual({
      knowledgeSource: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetKnowledgeBase]).toEqual({
      knowledgeSource: ["read"],
    });
    expect(
      requiredEndpointPermissionsMap[RouteId.GetKnowledgeBaseHealth],
    ).toEqual({ knowledgeSource: ["read"] });

    // Create route requires knowledgeSource:create
    expect(requiredEndpointPermissionsMap[RouteId.CreateKnowledgeBase]).toEqual(
      { knowledgeSource: ["create"] },
    );

    // Update route requires knowledgeSource:update
    expect(requiredEndpointPermissionsMap[RouteId.UpdateKnowledgeBase]).toEqual(
      { knowledgeSource: ["update"] },
    );

    // Delete route requires knowledgeSource:delete
    expect(requiredEndpointPermissionsMap[RouteId.DeleteKnowledgeBase]).toEqual(
      { knowledgeSource: ["delete"] },
    );

    // Connector read routes require knowledgeSource:read
    expect(requiredEndpointPermissionsMap[RouteId.GetConnectors]).toEqual({
      knowledgeSource: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetConnector]).toEqual({
      knowledgeSource: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetConnectorRuns]).toEqual({
      knowledgeSource: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetConnectorRun]).toEqual({
      knowledgeSource: ["read"],
    });

    // Connector write routes require knowledgeSource:create/update/delete
    expect(requiredEndpointPermissionsMap[RouteId.CreateConnector]).toEqual({
      knowledgeSource: ["create"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.UpdateConnector]).toEqual({
      knowledgeSource: ["update"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.DeleteConnector]).toEqual({
      knowledgeSource: ["delete"],
    });
  });

  test("member cannot have create, update, or delete access to knowledge base routes", async () => {
    const { memberPermissions, requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    const { RouteId } = await import("@archestra/shared");

    const memberKbActions = memberPermissions.knowledgeSource;

    // Verify member lacks permissions for write routes
    const writeRoutes = [
      RouteId.CreateKnowledgeBase,
      RouteId.UpdateKnowledgeBase,
      RouteId.DeleteKnowledgeBase,
      RouteId.CreateConnector,
      RouteId.UpdateConnector,
      RouteId.DeleteConnector,
    ];

    for (const routeId of writeRoutes) {
      const required = requiredEndpointPermissionsMap[routeId];
      expect(required?.knowledgeSource).toBeDefined();
      const requiredActions = required?.knowledgeSource ?? [];
      const hasAll = requiredActions.every((action: string) =>
        memberKbActions.includes(action as never),
      );
      expect(hasAll).toBe(false);
    }

    // Verify member has permissions for read routes
    const readRoutes = [
      RouteId.GetKnowledgeBases,
      RouteId.GetKnowledgeBase,
      RouteId.GetKnowledgeBaseHealth,
      RouteId.GetConnectors,
      RouteId.GetConnector,
      RouteId.GetConnectorRuns,
      RouteId.GetConnectorRun,
    ];

    for (const routeId of readRoutes) {
      const required = requiredEndpointPermissionsMap[routeId];
      expect(required?.knowledgeSource).toBeDefined();
      const requiredActions = required?.knowledgeSource ?? [];
      const hasAll = requiredActions.every((action: string) =>
        memberKbActions.includes(action as never),
      );
      expect(hasAll).toBe(true);
    }
  });

  describe("knowledge source visibility", () => {
    let app: FastifyInstanceWithZod;
    let user: User;
    let organizationId: string;

    beforeEach(async ({ makeOrganization, makeUser }) => {
      user = await makeUser();
      const organization = await makeOrganization();
      organizationId = organization.id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: unknown }).user = user;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
      await app.register(knowledgeBaseRoutes);
    });

    afterEach(async () => {
      await app.close();
    });

    test("GET /api/knowledge-bases returns all knowledge bases and filters nested connectors by visibility", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeTeam,
      makeUser,
    }) => {
      const hiddenOwner = await makeUser();
      const hiddenTeam = await makeTeam(organizationId, hiddenOwner.id, {
        name: "Hidden Team",
      });

      const orgWideKb = await makeKnowledgeBase(organizationId, {
        name: "Org Wide KB",
      });
      const visibleTeamKb = await makeKnowledgeBase(organizationId, {
        name: "Visible Team KB",
      });
      const hiddenTeamKb = await makeKnowledgeBase(organizationId, {
        name: "Hidden Team KB",
      });
      const kbWithHiddenConnector = await makeKnowledgeBase(organizationId, {
        name: "KB With Hidden Connector",
      });

      const visibleConnector = await makeKnowledgeBaseConnector(
        orgWideKb.id,
        organizationId,
        {
          name: "Visible Connector",
          connectorType: "jira",
        },
      );
      await makeKnowledgeBaseConnector(visibleTeamKb.id, organizationId, {
        name: "Visible Team Connector",
        connectorType: "confluence",
      });
      await makeKnowledgeBaseConnector(hiddenTeamKb.id, organizationId, {
        name: "Hidden Team Connector",
        connectorType: "github",
      });
      await makeKnowledgeBaseConnector(
        kbWithHiddenConnector.id,
        organizationId,
        {
          name: "Hidden Connector On Visible KB",
          visibility: "team-scoped",
          teamIds: [hiddenTeam.id],
          connectorType: "gitlab",
        },
      );

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-bases?limit=20&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{
          name: string;
          connectors: Array<{
            id: string;
            name: string;
            connectorType: string;
          }>;
        }>;
        pagination: { total: number };
      };

      expect(body.pagination.total).toBe(4);
      expect(body.data.map((kb) => kb.name).sort()).toEqual([
        "Hidden Team KB",
        "KB With Hidden Connector",
        "Org Wide KB",
        "Visible Team KB",
      ]);
      expect(
        body.data.find((kb) => kb.name === "Org Wide KB")?.connectors,
      ).toEqual([
        {
          id: visibleConnector.id,
          name: "Visible Connector",
          connectorType: "jira",
        },
      ]);
      expect(
        body.data.find((kb) => kb.name === "KB With Hidden Connector")
          ?.connectors,
      ).toEqual([]);
    });

    test("GET /api/connectors filters hidden connectors from results", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeTeam,
      makeUser,
    }) => {
      const hiddenOwner = await makeUser();
      const hiddenTeam = await makeTeam(organizationId, hiddenOwner.id);
      const kb = await makeKnowledgeBase(organizationId, { name: "Search KB" });

      const visibleConnector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          name: "Visible Connector",
        },
      );
      await makeKnowledgeBaseConnector(kb.id, organizationId, {
        name: "Hidden Connector",
        visibility: "team-scoped",
        teamIds: [hiddenTeam.id],
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/connectors?limit=20&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ id: string; name: string }>;
        pagination: { total: number };
      };

      expect(body.pagination.total).toBe(1);
      expect(body.data).toEqual([
        expect.objectContaining({
          id: visibleConnector.id,
          name: "Visible Connector",
        }),
      ]);
    });

    test("GET /api/connectors/:id returns 404 for hidden team-scoped connector", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeTeam,
      makeUser,
    }) => {
      const hiddenOwner = await makeUser();
      const hiddenTeam = await makeTeam(organizationId, hiddenOwner.id);
      const kb = await makeKnowledgeBase(organizationId);
      const hiddenConnector = await makeKnowledgeBaseConnector(
        kb.id,
        organizationId,
        {
          visibility: "team-scoped",
          teamIds: [hiddenTeam.id],
        },
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${hiddenConnector.id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          message: "Connector not found",
          type: "api_not_found_error",
        },
      });
    });

    test("PUT /api/connectors/:id refreshes document and chunk ACL when visibility changes", async ({
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeTeam,
    }) => {
      const kb = await makeKnowledgeBase(organizationId);
      const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
      const team = await makeTeam(organizationId, user.id, {
        name: "Scoped Team",
      });
      const document = await KbDocumentModel.create({
        organizationId,
        sourceId: "ext-1",
        connectorId: connector.id,
        title: "Doc 1",
        content: "content",
        contentHash: "hash-1",
        acl: ["org:*"],
      });
      await KbChunkModel.insertMany([
        {
          documentId: document.id,
          content: "chunk 1",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);

      const original = config.enterpriseFeatures.knowledgeBase;
      Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
        value: true,
        writable: true,
        configurable: true,
      });

      let response: Awaited<ReturnType<typeof app.inject>>;
      try {
        response = await app.inject({
          method: "PUT",
          url: `/api/connectors/${connector.id}`,
          payload: {
            visibility: "team-scoped",
            teamIds: [team.id],
          },
        });
      } finally {
        Object.defineProperty(config.enterpriseFeatures, "knowledgeBase", {
          value: original,
          writable: true,
          configurable: true,
        });
        enterpriseTier.setUserCountForTesting(0);
      }

      expect(response.statusCode).toBe(200);
      const refreshedDocument = await KbDocumentModel.findById(document.id);
      const refreshedChunks = await KbChunkModel.findByDocument(document.id);
      expect(refreshedDocument?.acl).toEqual([`team:${team.id}`]);
      expect(refreshedChunks[0]?.acl).toEqual([`team:${team.id}`]);
    });
  });
});
