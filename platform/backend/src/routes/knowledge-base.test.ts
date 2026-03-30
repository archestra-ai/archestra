import { KnowledgeBaseConnectorModel, KnowledgeBaseModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
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

    test("returns 404 for non-existent connector", async () => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/connectors/${crypto.randomUUID()}`,
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(404);
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
  test("member permissions only allow read and query for knowledgeBase", async () => {
    const { memberPermissions } = await import("@shared/access-control");
    expect(memberPermissions.knowledgeBase).toEqual(["read", "query"]);
    expect(memberPermissions.knowledgeBase).not.toContain("create");
    expect(memberPermissions.knowledgeBase).not.toContain("update");
    expect(memberPermissions.knowledgeBase).not.toContain("delete");
  });

  test("admin permissions include full CRUD for knowledgeBase", async () => {
    const { adminPermissions } = await import("@shared/access-control");
    expect(adminPermissions.knowledgeBase).toContain("read");
    expect(adminPermissions.knowledgeBase).toContain("create");
    expect(adminPermissions.knowledgeBase).toContain("update");
    expect(adminPermissions.knowledgeBase).toContain("delete");
    expect(adminPermissions.knowledgeBase).toContain("query");
  });

  test("knowledge base routes require correct permissions", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@shared/access-control"
    );
    const { RouteId } = await import("@shared");

    // Read routes require knowledgeBase:read
    expect(requiredEndpointPermissionsMap[RouteId.GetKnowledgeBases]).toEqual({
      knowledgeBase: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetKnowledgeBase]).toEqual({
      knowledgeBase: ["read"],
    });
    expect(
      requiredEndpointPermissionsMap[RouteId.GetKnowledgeBaseHealth],
    ).toEqual({ knowledgeBase: ["read"] });

    // Create route requires knowledgeBase:create
    expect(requiredEndpointPermissionsMap[RouteId.CreateKnowledgeBase]).toEqual(
      { knowledgeBase: ["create"] },
    );

    // Update route requires knowledgeBase:update
    expect(requiredEndpointPermissionsMap[RouteId.UpdateKnowledgeBase]).toEqual(
      { knowledgeBase: ["update"] },
    );

    // Delete route requires knowledgeBase:delete
    expect(requiredEndpointPermissionsMap[RouteId.DeleteKnowledgeBase]).toEqual(
      { knowledgeBase: ["delete"] },
    );

    // Connector read routes require knowledgeBase:read
    expect(requiredEndpointPermissionsMap[RouteId.GetConnectors]).toEqual({
      knowledgeBase: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetConnector]).toEqual({
      knowledgeBase: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetConnectorRuns]).toEqual({
      knowledgeBase: ["read"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.GetConnectorRun]).toEqual({
      knowledgeBase: ["read"],
    });

    // Connector write routes require knowledgeBase:create/update/delete
    expect(requiredEndpointPermissionsMap[RouteId.CreateConnector]).toEqual({
      knowledgeBase: ["create"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.UpdateConnector]).toEqual({
      knowledgeBase: ["update"],
    });
    expect(requiredEndpointPermissionsMap[RouteId.DeleteConnector]).toEqual({
      knowledgeBase: ["delete"],
    });
  });

  test("member cannot have create, update, or delete access to knowledge base routes", async () => {
    const { memberPermissions, requiredEndpointPermissionsMap } = await import(
      "@shared/access-control"
    );
    const { RouteId } = await import("@shared");

    const memberKbActions = memberPermissions.knowledgeBase;

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
      expect(required?.knowledgeBase).toBeDefined();
      const requiredActions = required?.knowledgeBase ?? [];
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
      expect(required?.knowledgeBase).toBeDefined();
      const requiredActions = required?.knowledgeBase ?? [];
      const hasAll = requiredActions.every((action: string) =>
        memberKbActions.includes(action as never),
      );
      expect(hasAll).toBe(true);
    }
  });
});
