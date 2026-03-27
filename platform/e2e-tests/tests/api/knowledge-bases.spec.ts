import { expect, test } from "./fixtures";

test.describe("Knowledge Bases API", () => {
  test.describe("Knowledge Base CRUD", () => {
    test("should create a knowledge base", async ({
      request,
      createKnowledgeBase,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const name = `E2E Knowledge Base Create ${uniqueSuffix}`;

      const response = await createKnowledgeBase(request, name);
      const kg = await response.json();

      expect(kg).toHaveProperty("id");
      expect(kg.name).toBe(name);
      expect(kg).toHaveProperty("createdAt");
      expect(kg).toHaveProperty("updatedAt");

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should get a knowledge base by ID", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const name = `E2E Knowledge Base Get ${uniqueSuffix}`;

      const createResponse = await createKnowledgeBase(request, name);
      const created = await createResponse.json();

      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-bases/${created.id}`,
      });
      const kg = await response.json();

      expect(kg.id).toBe(created.id);
      expect(kg.name).toBe(name);

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should list knowledge bases with pagination", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const name1 = `E2E Knowledge Base List A ${uniqueSuffix}`;
      const name2 = `E2E Knowledge Base List B ${uniqueSuffix}`;

      const res1 = await createKnowledgeBase(request, name1);
      const kg1 = await res1.json();
      const res2 = await createKnowledgeBase(request, name2);
      const kg2 = await res2.json();

      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/knowledge-bases?limit=50&offset=0",
      });
      const body = await response.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toHaveProperty("total");
      expect(body.pagination).toHaveProperty("currentPage");
      expect(body.pagination).toHaveProperty("totalPages");
      expect(body.pagination).toHaveProperty("hasNext");
      expect(body.pagination).toHaveProperty("hasPrev");

      const ids = body.data.map((kg: { id: string }) => kg.id);
      expect(ids).toContain(kg1.id);
      expect(ids).toContain(kg2.id);

      // Cleanup
      await deleteKnowledgeBase(request, kg1.id);
      await deleteKnowledgeBase(request, kg2.id);
    });

    test("should update a knowledge base", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const createResponse = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Update ${uniqueSuffix}`,
      );
      const created = await createResponse.json();

      const updatedName = `E2E Knowledge Base Updated ${uniqueSuffix}`;

      const updateResponse = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/knowledge-bases/${created.id}`,
        data: { name: updatedName },
      });
      const updated = await updateResponse.json();

      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe(updatedName);

      // Verify changes persisted
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-bases/${created.id}`,
      });
      const fetched = await getResponse.json();
      expect(fetched.name).toBe(updatedName);

      // Cleanup
      await deleteKnowledgeBase(request, created.id);
    });

    test("should delete a knowledge base", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const createResponse = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Delete ${uniqueSuffix}`,
      );
      const created = await createResponse.json();

      const deleteResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/knowledge-bases/${created.id}`,
      });
      const result = await deleteResponse.json();
      expect(result.success).toBe(true);

      // Verify 404 on re-fetch
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-bases/${created.id}`,
        ignoreStatusCheck: true,
      });
      expect(getResponse.status()).toBe(404);
    });

    test("should return 400 when creating with missing required fields", async ({
      request,
      makeApiRequest,
    }) => {
      // Missing name
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/knowledge-bases",
        data: {},
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(400);
    });

    test("should return 404 for non-existent knowledge base", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-bases/${crypto.randomUUID()}`,
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(404);
    });
  });

  test.describe("Knowledge Base RBAC", () => {
    test("member can list knowledge bases", async ({
      memberRequest,
      makeApiRequest,
    }) => {
      await expect(async () => {
        const response = await makeApiRequest({
          request: memberRequest,
          method: "get",
          urlSuffix: "/api/knowledge-bases?limit=10&offset=0",
          ignoreStatusCheck: true,
        });
        expect(response.status()).toBe(200);

        const body = await response.json();
        expect(body).toHaveProperty("data");
        expect(body).toHaveProperty("pagination");
      }).toPass({ timeout: 15_000, intervals: [1000, 3000, 5000] });
    });

    test("member cannot create a knowledge base", async ({
      memberRequest,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/knowledge-bases",
        data: {
          name: "Member Knowledge Base Attempt",
        },
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(403);
    });

    test("member cannot delete a knowledge base", async ({
      request,
      memberRequest,
      makeApiRequest,
      createKnowledgeBase,
      deleteKnowledgeBase,
    }) => {
      // Create as admin
      const createResponse = await createKnowledgeBase(
        request,
        `E2E Knowledge Base RBAC Delete ${crypto.randomUUID().slice(0, 8)}`,
      );
      const kg = await createResponse.json();

      // Try to delete as member
      const deleteResponse = await makeApiRequest({
        request: memberRequest,
        method: "delete",
        urlSuffix: `/api/knowledge-bases/${kg.id}`,
        ignoreStatusCheck: true,
      });
      expect(deleteResponse.status()).toBe(403);

      // Cleanup as admin
      await deleteKnowledgeBase(request, kg.id);
    });
  });

  test.describe("Connector CRUD", () => {
    test("should create a connector", async ({
      request,
      createKnowledgeBase,
      createConnector,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Connector Create ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connectorName = `E2E Connector ${uniqueSuffix}`;
      const connectorRes = await createConnector(request, kg.id, connectorName);
      const connector = await connectorRes.json();

      expect(connector).toHaveProperty("id");
      expect(connector.name).toBe(connectorName);
      expect(connector.connectorType).toBe("jira");
      expect(connector).toHaveProperty("config");
      expect(connector).toHaveProperty("schedule");
      expect(connector.enabled).toBe(true);
      expect(connector).toHaveProperty("createdAt");
      expect(connector).toHaveProperty("updatedAt");

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should get a connector by ID", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      createConnector,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Connector Get ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connectorName = `E2E Connector Get ${uniqueSuffix}`;
      const connectorRes = await createConnector(request, kg.id, connectorName);
      const connector = await connectorRes.json();

      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors/${connector.id}`,
      });
      const fetched = await getResponse.json();

      expect(fetched.id).toBe(connector.id);
      expect(fetched.name).toBe(connectorName);
      expect(fetched.connectorType).toBe("jira");

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should list connectors for a knowledge base", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      createConnector,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Connector List ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes1 = await createConnector(
        request,
        kg.id,
        `E2E Conn List A ${uniqueSuffix}`,
      );
      const conn1 = await connRes1.json();
      const connRes2 = await createConnector(
        request,
        kg.id,
        `E2E Conn List B ${uniqueSuffix}`,
      );
      const conn2 = await connRes2.json();

      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors?knowledgeBaseId=${kg.id}&limit=50&offset=0`,
      });
      const body = await listResponse.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);

      const ids = body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(conn1.id);
      expect(ids).toContain(conn2.id);

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should update a connector", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      createConnector,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Connector Update ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Update ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      const updatedName = `E2E Conn Updated ${uniqueSuffix}`;
      const updateResponse = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/connectors/${connector.id}`,
        data: {
          name: updatedName,
          enabled: false,
          schedule: "0 0 * * *",
        },
      });
      const updated = await updateResponse.json();

      expect(updated.id).toBe(connector.id);
      expect(updated.name).toBe(updatedName);
      expect(updated.enabled).toBe(false);
      expect(updated.schedule).toBe("0 0 * * *");

      // Verify changes persisted
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors/${connector.id}`,
      });
      const fetched = await getResponse.json();
      expect(fetched.name).toBe(updatedName);
      expect(fetched.enabled).toBe(false);

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should delete a connector", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      createConnector,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Connector Delete ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Delete ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      const deleteResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/connectors/${connector.id}`,
      });
      const result = await deleteResponse.json();
      expect(result.success).toBe(true);

      // Verify 404 on re-fetch
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors/${connector.id}`,
        ignoreStatusCheck: true,
      });
      expect(getResponse.status()).toBe(404);

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });

    test("should return 400 when creating connector with invalid type", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Connector Invalid ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/connectors",
        data: {
          name: "Invalid Connector",
          knowledgeBaseIds: [kg.id],
          connectorType: "invalid_type",
          config: { baseUrl: "https://test.atlassian.net" },
          credentials: { email: "test@example.com", apiToken: "tok" },
        },
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(400);

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });
  });

  test.describe("Connector Runs", () => {
    test("should list connector runs (empty initially)", async ({
      request,
      makeApiRequest,
      createKnowledgeBase,
      createConnector,
      deleteKnowledgeBase,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeBase(
        request,
        `E2E Knowledge Base Runs ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Runs ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      const runsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors/${connector.id}/runs?limit=10&offset=0`,
      });
      const body = await runsResponse.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination.total).toBe(0);

      // Cleanup
      await deleteKnowledgeBase(request, kg.id);
    });
  });
});
