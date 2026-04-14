import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";

describe("knowledge base routes", () => {
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
  });

  describe("GET /api/connectors", () => {
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

    test("refreshes ACLs when visibility inputs change", async () => {
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Refresh ACL Connector",
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
          visibility: "team-scoped",
          teamIds: [crypto.randomUUID()],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(refreshSpy).toHaveBeenCalledWith(connector.id);
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
});

// ===== RBAC Permission Configuration =====
// Verify that the permission map correctly restricts member access to read-only.
// This is the declarative layer that the auth middleware enforces at runtime.

describe("knowledge base permission configuration", () => {
  test("member permissions only allow read and query for knowledgeSource", async () => {
    const { memberPermissions } = await import("@shared/access-control");
    expect(memberPermissions.knowledgeSource).toEqual(["read", "query"]);
    expect(memberPermissions.knowledgeSource).not.toContain("create");
    expect(memberPermissions.knowledgeSource).not.toContain("update");
    expect(memberPermissions.knowledgeSource).not.toContain("delete");
  });

  test("admin permissions include full CRUD for knowledgeSource", async () => {
    const { adminPermissions } = await import("@shared/access-control");
    expect(adminPermissions.knowledgeSource).toContain("read");
    expect(adminPermissions.knowledgeSource).toContain("create");
    expect(adminPermissions.knowledgeSource).toContain("update");
    expect(adminPermissions.knowledgeSource).toContain("delete");
    expect(adminPermissions.knowledgeSource).toContain("query");
  });

  test("knowledge base routes require correct permissions", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@shared/access-control"
    );
    const { RouteId } = await import("@shared");

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
      "@shared/access-control"
    );
    const { RouteId } = await import("@shared");

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

      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${connector.id}`,
        payload: {
          visibility: "team-scoped",
          teamIds: [team.id],
        },
      });

      expect(response.statusCode).toBe(200);
      const refreshedDocument = await KbDocumentModel.findById(document.id);
      const refreshedChunks = await KbChunkModel.findByDocument(document.id);
      expect(refreshedDocument?.acl).toEqual([`team:${team.id}`]);
      expect(refreshedChunks[0]?.acl).toEqual([`team:${team.id}`]);
    });
  });
});
